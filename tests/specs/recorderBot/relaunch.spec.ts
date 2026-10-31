import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IConsultation,
    type IEvidenceFile,
    type IManifest,
    type ITimelineEntry,
    evidencePath,
    getConsultation,
    getHiddenIds,
    killBotBrowser,
    patientLinkRoom,
    playMedia,
    readEvidenceJson,
    relaunchUnavailableReason,
    startConsultation,
    uniqueHn,
    waitForEvidence,
    waitForFinalStatus,
    waitForHiddenParticipant,
    waitForNewBot,
    waitForRecording
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The bot\'s browser is killed in the middle of a consultation. The service relaunches the bot into \
the same consultation, and the evidence recording shows the gap, with files from before and after it, while another \
consultation records on undisturbed. With no relaunches allowed, a crash stops the consultation as failed, with what \
was recorded stored. Skipped unless the recorderBot.available expectation, RECORDER_BOT_STORAGE_ROOT, \
RECORDER_BOT_CONTAINER, RECORDER_BOT_FRAGILE_API_URL and RECORDER_BOT_FRAGILE_CONTAINER are set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

/**
 * Reads a stored evidence recording.
 *
 * @param {IConsultation} consultation - The consultation.
 * @returns {Object} Its manifest and its timeline.
 */
function readEvidence(consultation: IConsultation): { manifest: IManifest; timeline: ITimelineEntry[]; } {
    const location = consultation.evidenceLocation ?? '';

    return {
        manifest: readEvidenceJson<IManifest>(location, 'manifest.json'),
        timeline: readEvidenceJson<{ entries: ITimelineEntry[]; }>(location, 'timeline.json').entries
    };
}

/**
 * Asserts that every file of an evidence recording plays.
 *
 * @param {IConsultation} consultation - The consultation.
 * @param {IEvidenceFile[]} files - Its files.
 * @returns {void}
 */
function expectPlayable(consultation: IConsultation, files: IEvidenceFile[]) {
    for (const file of files) {
        expect(playMedia(evidencePath(consultation.evidenceLocation ?? '', file.name)).duration).toBeGreaterThan(1);
    }
}

describe('Recorder bot: relaunch after a crash', () => {
    let patient: Participant;
    let other: Participant;
    let patientEndpoint: string;
    let crashed: string;
    let calm: string;

    it('setup', async () => {
        const unavailable = relaunchUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const crashedHn = uniqueHn('CRASH');
        const calmHn = uniqueHn('CALM');

        patient = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(crashedHn) });
        patientEndpoint = await patient.getEndpointId();
        other = await joinMuc({ name: 'p2' }, { roomName: patientLinkRoom(calmHn) });
        crashed = (await startConsultation(crashedHn)).consultationId;
        calm = (await startConsultation(calmHn)).consultationId;
        await waitForRecording(crashed);
        await waitForRecording(calm);
        await waitForHiddenParticipant(patient);
        await patient.driver.pause(5_000);
    });

    it('a bot whose browser is killed is relaunched into the same consultation', async () => {
        const before = await getHiddenIds(patient);

        killBotBrowser(crashed);
        await waitForNewBot(patient, before);

        const consultation = await getConsultation(crashed);

        expect(consultation.status).toBe('recording');
        expect(consultation.relaunches).toBe(1);

        // Let the relaunched bot record for a while.
        await patient.driver.pause(6_000);
    });

    it('another consultation records on undisturbed', async () => {
        const consultation = await getConsultation(calm);

        expect(consultation.status).toBe('recording');
        expect(consultation.relaunches).toBe(0);
    });

    it('the evidence recording shows the gap, with the files from before and after it', async () => {
        await patient.getToolbar().clickEndMeetingForAllButton();

        const consultation = await waitForEvidence(crashed);
        const { manifest, timeline } = readEvidence(consultation);
        const interrupted = timeline.find(e => e.type === 'bot_interrupted');
        const resumed = timeline.find(e => e.type === 'bot_resumed');

        expect(consultation.stopReason).toBe('room_destroyed');
        expect(manifest.gaps).toEqual([ { end: resumed?.at, start: interrupted?.at } ]);

        const [ gap ] = manifest.gaps;
        const before = manifest.files.filter(f => f.stop <= gap.start);
        const after = manifest.files.filter(f => f.start >= gap.end);

        // The patient's audio and video, recorded to new files in the same folder once the bot is back.
        expect(before.map(f => f.kind).sort()).toEqual([ 'audio', 'video' ]);
        expect(after.map(f => f.kind).sort()).toEqual([ 'audio', 'video' ]);
        expect(manifest.files.length).toBe(4);
        expect(manifest.files.every(f => f.endpointId === patientEndpoint)).toBe(true);
        expectPlayable(consultation, manifest.files);

        // The patient stayed through the gap: one join, no leave. The relaunched bot may still see the crashed bot's
        // session in the room for a while; that is not a human.
        expect(manifest.participants.filter(p => !p.hidden).map(p => [ p.endpointId, p.joins.length, p.leaves.length ]))
            .toEqual([ [ patientEndpoint, 1, 0 ] ]);
    });

    it('the other consultation\'s evidence recording has no gap', async () => {
        await other.getToolbar().clickEndMeetingForAllButton();

        const { manifest, timeline } = readEvidence(await waitForEvidence(calm));

        expect(manifest.gaps).toEqual([]);
        expect(timeline.filter(e => e.type === 'bot_interrupted')).toEqual([]);
    });

    it('with no relaunches left, a crash stops the consultation as failed and stores what was recorded', async () => {
        const { fragileApiUrl: apiUrl, fragileContainer } = config.recorderBot;
        const hn = uniqueHn('FRAGILE');

        patient = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(hn) });

        const consultationId = (await startConsultation(hn, apiUrl)).consultationId;

        await waitForRecording(consultationId, apiUrl);
        await patient.driver.pause(5_000);
        killBotBrowser(consultationId, fragileContainer);

        const consultation = await waitForFinalStatus(consultationId, { apiUrl });

        expect(consultation).toEqual(expect.objectContaining({
            relaunches: 0,
            status: 'failed',
            stopReason: 'bot_failed'
        }));
        expect(consultation.error).toMatch(/^bot_failed: /);
        expect(consultation.evidenceLocation).toBeTruthy();

        const { manifest } = readEvidence(consultation);

        // The gap runs from the crash to the end.
        expect(manifest.gaps.map(g => g.end)).toEqual([ manifest.end ]);
        expect(manifest.files.map(f => f.kind).sort()).toEqual([ 'audio', 'video' ]);
        expectPlayable(consultation, manifest.files);
    });
});
