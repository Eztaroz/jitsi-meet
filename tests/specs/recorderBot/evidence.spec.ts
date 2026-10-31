import fs from 'node:fs';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IConsultation,
    type IManifest,
    type ITimelineEntry,
    evidencePath,
    evidenceUnavailableReason,
    patientLinkRoom,
    playMedia,
    readEvidenceJson,
    setCameraHeight,
    startConsultation,
    uniqueHn,
    waitForEvidence,
    waitForRecording
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'A consultation in which staff leave and join again is ended for everyone. Its evidence recording \
lands in the evidence storage root: one playable audio and one playable video file for each participant join, the \
timeline and the manifest. Skipped unless the recorderBot.available expectation and RECORDER_BOT_STORAGE_ROOT are set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

/** How long the evidence recording may take to appear in storage once the meeting ends. */
const PROMPT_MS = 15_000;

/**
 * How far a file's duration may be from its interval on the timeline, in seconds. Video starts at its first frame,
 * which comes up to about 1.5 s after the track does.
 */
const DURATION_TOLERANCE_S = 3;

/** The resolution the patient's camera drops to mid-consultation. */
const LOW_HEIGHT = 180;

describe('Recorder bot: evidence recording', () => {
    let patient: Participant;
    let hn: string;
    let consultationId: string;
    let consultation: IConsultation;
    let manifest: IManifest;
    let timeline: ITimelineEntry[];

    /** The endpoint of each participant join, in order: the patient, then staff twice. */
    const joins: Array<{ endpointId: string; name: string; }> = [];

    it('setup', async () => {
        const unavailable = evidenceUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('EV');

        const room = patientLinkRoom(hn);

        patient = await joinMuc({ name: 'p1' }, { roomName: room });
        joins.push({ endpointId: await patient.getEndpointId(), name: 'p1' });
        consultationId = (await startConsultation(hn)).consultationId;
        await waitForRecording(consultationId);

        let staff = await joinMuc({ name: 'p2' }, { roomName: room });

        joins.push({ endpointId: await staff.getEndpointId(), name: 'p2' });
        await patient.driver.pause(6_000);

        // The bot receives the patient's video at a lower resolution from here on.
        await setCameraHeight(patient, LOW_HEIGHT);
        await patient.driver.pause(6_000);

        // A rejoin is a new endpoint, recorded to new files.
        await staff.hangup();
        staff = await joinMuc({ name: 'p2' }, { roomName: room });
        joins.push({ endpointId: await staff.getEndpointId(), name: 'p2' });
        await staff.driver.pause(6_000);
    });

    it('the evidence recording appears in storage promptly once the meeting is ended for everyone', async () => {
        await patient.getToolbar().clickEndMeetingForAllButton();

        const endedAt = Date.now();

        consultation = await waitForEvidence(consultationId);
        expect(Date.now() - endedAt).toBeLessThan(PROMPT_MS);
        expect(consultation.stopReason).toBe('room_destroyed');

        // <backend-safe HN>/<consultation start in UTC, ISO 8601 basic format>
        expect(consultation.evidenceLocation).toBe(
            `${encodeURIComponent(hn.toLowerCase()).toLowerCase()}/${consultation.startedAt.replace(/[-:]/g, '')}`);

        const location = consultation.evidenceLocation ?? '';

        manifest = readEvidenceJson<IManifest>(location, 'manifest.json');
        timeline = readEvidenceJson<{ entries: ITimelineEntry[]; }>(location, 'timeline.json').entries;

        expect(manifest).toEqual(expect.objectContaining({
            consultationId,
            end: consultation.stoppedAt,
            gaps: [],
            hn,
            room: encodeURIComponent(hn.toLowerCase()).toLowerCase(),
            staffVisits: [],
            start: consultation.startedAt,
            stopReason: 'room_destroyed'
        }));
        expect(manifest.meetingId).toBeTruthy();
        expect(timeline[timeline.length - 1]).toEqual({
            at: consultation.stoppedAt,
            reason: 'room_destroyed',
            type: 'stopped'
        });
    });

    it('the manifest lists every participant join, each with one audio and one video file', () => {
        expect(manifest.participants.map(p => [ p.endpointId, p.displayName ]))
            .toEqual(joins.map(j => [ j.endpointId, j.name ]));

        // Staff's first join is the one that left before the end.
        expect(manifest.participants.map(p => [ p.joins.length, p.leaves.length ])).toEqual([ [ 1, 0 ], [ 1, 1 ], [ 1, 0 ] ]);

        for (const { endpointId } of joins) {
            expect(manifest.files.filter(f => f.endpointId === endpointId).map(f => f.kind)
                .sort()).toEqual([ 'audio', 'video' ]);
        }
        expect(manifest.files.length).toBe(joins.length * 2);
    });

    it('every file plays, with a duration close to its interval on the timeline', () => {
        for (const file of manifest.files) {
            const filePath = evidencePath(consultation.evidenceLocation ?? '', file.name);
            const interval = (Date.parse(file.stop) - Date.parse(file.start)) / 1000;
            const playback = playMedia(filePath);

            expect(fs.statSync(filePath).size).toBe(file.bytes);
            expect(file.duration).toBeCloseTo(playback.duration, 1);
            expect(Math.abs(playback.duration - interval)).toBeLessThan(DURATION_TOLERANCE_S);

            expect(timeline).toContainEqual({
                at: file.start,
                endpointId: file.endpointId,
                file: file.name,
                kind: file.kind,
                type: 'track_started'
            });
            expect(timeline).toContainEqual({ at: file.stop, file: file.name, type: 'track_stopped' });
        }
    });

    it('a change of video resolution stays inside one playable file, and the timeline records it', () => {
        const video = manifest.files.find(f => f.endpointId === joins[0].endpointId && f.kind === 'video');
        const { heights } = playMedia(evidencePath(consultation.evidenceLocation ?? '', video?.name));
        const recorded = timeline
            .filter(e => e.type === 'video_resolution' && e.file === video?.name)
            .map(e => e.height as number);

        // Frames above the low resolution, then frames at it.
        for (const sizes of [ heights, recorded ]) {
            const tall = sizes.findIndex(h => h > LOW_HEIGHT);

            expect(tall).toBeGreaterThanOrEqual(0);
            expect(sizes.slice(tall)).toContain(LOW_HEIGHT);
        }
    });
});
