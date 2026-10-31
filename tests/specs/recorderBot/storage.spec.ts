import fs from 'node:fs';
import path from 'node:path';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IManifest,
    type ITimelineEntry,
    STORAGE_ROOT_MARKER,
    docker,
    evidencePath,
    findEvidence,
    getConsultation,
    makeStorageRoot,
    patientLinkRoom,
    playMedia,
    readEvidenceJson,
    startConsultation,
    storageUnavailableReason,
    uniqueHn,
    waitForConsultation,
    waitForFinalStatus,
    waitForRecording
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'While the evidence storage root is unavailable, a consultation\'s evidence recording stays in the \
spool and the consultation is spooled. A folder not marked as the storage root, as an unmounted mount point is, is \
unavailable too, and the service writes nothing there; so is a storage root it cannot write to. The service retries \
the move until it succeeds, and the \
consultation is then stored, with the whole evidence recording in the storage root. A failed attempt leaves nothing \
in the storage root. Evidence recordings spooled before the service restarts are retried after it. Skipped unless the \
recorderBot.available expectation and the RECORDER_BOT_ISOLATED_* variables are set.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: unavailable storage root', () => {
    const { apiUrl, container = '', retrySeconds, spool = '', storageRoot: root = '' } = config.recorderBot.isolated;
    const retryMs = retrySeconds * 1000;
    let patient: Participant;
    let consultationId: string;

    /**
     * Takes the storage root away, as when its share is not mounted. What an earlier run stored is kept aside.
     *
     * @returns {void}
     */
    function takeStorageRootAway() {
        if (fs.existsSync(root)) {
            fs.renameSync(root, `${root}-${Date.now()}`);
        }
    }

    /**
     * Records a short consultation on the isolated instance, and ends it.
     *
     * @param {string} label - Distinguishes its HN.
     * @returns {Promise<string>} The consultation id.
     */
    async function recordConsultation(label: string): Promise<string> {
        const hn = uniqueHn(label);

        patient = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(hn) });

        const id = (await startConsultation(hn, apiUrl)).consultationId;

        await waitForRecording(id, apiUrl);
        await patient.driver.pause(4_000);
        await patient.getToolbar().clickEndMeetingForAllButton();

        return id;
    }

    /**
     * Returns the errors the service logged as it failed to move a spooled evidence recording to the storage root.
     *
     * @param {string} id - Its consultation.
     * @param {Date} since - From when.
     * @returns {string[]}
     */
    function retryErrors(id: string, since: Date): string[] {
        return docker('logs', '--since', since.toISOString(), container)
            .split('\n')
            .flatMap(line => {
                try {
                    return [ JSON.parse(line) as Record<string, string> ];
                } catch {
                    return [];
                }
            })
            .filter(l => l.consultationId === id
                && l.message === 'could not move a spooled evidence recording to the storage root; will retry')
            .map(l => l.error);
    }

    /**
     * Asserts that a stored evidence recording is complete: its manifest, its timeline and every file it lists,
     * each whole and playable, and nothing else.
     *
     * @param {string} location - Where it is in the storage root.
     * @param {string} id - Its consultation.
     * @returns {void}
     */
    function expectComplete(location: string, id: string) {
        const manifest = readEvidenceJson<IManifest>(location, 'manifest.json', root);
        const timeline = readEvidenceJson<{ consultationId: string; entries: ITimelineEntry[]; }>(
            location, 'timeline.json', root);

        expect(manifest.consultationId).toBe(id);
        expect(manifest.stopReason).toBe('room_destroyed');
        expect(timeline.consultationId).toBe(id);
        expect(timeline.entries.map(e => e.type)).toContain('stopped');
        expect(manifest.files.map(f => f.kind).sort()).toEqual([ 'audio', 'video' ]);
        for (const file of manifest.files) {
            const filePath = evidencePath(location, file.name, root);

            expect(fs.statSync(filePath).size).toBe(file.bytes);
            expect(playMedia(filePath).duration).toBeGreaterThan(1);
        }
        expect(fs.readdirSync(evidencePath(location, '', root)).sort())
            .toEqual([ 'manifest.json', 'timeline.json', ...manifest.files.map(f => f.name) ].sort());

        // Moved, not copied.
        expect(fs.existsSync(path.join(spool, id))).toBe(false);
    }

    it('setup', () => {
        const unavailable = storageUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }
        takeStorageRootAway();
    });

    it('while the storage root is unavailable, the evidence recording stays in the spool', async () => {
        consultationId = await recordConsultation('UNAVAILABLE');

        const consultation = await waitForFinalStatus(consultationId, { apiUrl });

        expect(consultation.status).toBe('spooled');
        expect(consultation.error).toMatch(/^store_failed: ENOENT/);
        expect(consultation.evidenceLocation).toBeUndefined();
        expect(fs.existsSync(path.join(spool, consultationId, 'manifest.json'))).toBe(true);
    });

    it('the service writes nothing to a folder not marked as the storage root', async () => {
        // The folder is there, as a mount point is while its share is not mounted, but it has no marker.
        fs.mkdirSync(root);
        await patient.driver.pause(3 * retryMs);

        expect((await getConsultation(consultationId, apiUrl)).status).toBe('spooled');
        expect(fs.readdirSync(root)).toEqual([]);
        expect(fs.existsSync(path.join(spool, consultationId, 'manifest.json'))).toBe(true);
    });

    it('the service stores nothing in a storage root it cannot write to', async () => {
        // The service's instance runs as root, but without the capability to override file permissions.
        makeStorageRoot(root);
        fs.chmodSync(root, 0o555);

        const since = new Date();

        await patient.driver.pause(3 * retryMs);

        expect((await getConsultation(consultationId, apiUrl)).status).toBe('spooled');
        expect(fs.readdirSync(root)).toEqual([ STORAGE_ROOT_MARKER ]);
        expect(retryErrors(consultationId, since)).toContain('EACCES');
        expect(fs.existsSync(path.join(spool, consultationId, 'manifest.json'))).toBe(true);
    });

    it('a failed attempt to store it leaves nothing in the storage root', async () => {
        // The storage root is writable again, but a file stands where the move stages its copy: the spool and the
        // storage root are on different mounts, so every attempt fails after it has created the patient's folder.
        fs.chmodSync(root, 0o755);
        fs.writeFileSync(path.join(root, '.incoming'), '');
        await patient.driver.pause(3 * retryMs);

        expect((await getConsultation(consultationId, apiUrl)).status).toBe('spooled');
        expect(fs.readdirSync(root).sort()).toEqual([ '.incoming', STORAGE_ROOT_MARKER ]);
        expect(fs.existsSync(path.join(spool, consultationId, 'manifest.json'))).toBe(true);
    });

    it('once the storage root works, the evidence recording moves into it whole and the consultation is stored',
        async () => {
            fs.rmSync(path.join(root, '.incoming'));

            const consultation = await waitForConsultation(consultationId, c => c.status === 'stored', {
                apiUrl,
                description: 'the spooled evidence recording to be stored',
                timeout: 5 * retryMs + 10_000
            });

            expect(consultation.error).toBeUndefined();
            expect(consultation.evidenceLocation).toBeTruthy();
            expectComplete(consultation.evidenceLocation ?? '', consultationId);

            // Nothing is left half-way.
            expect(fs.readdirSync(path.join(root, '.incoming'))).toEqual([]);
        });

    it('an evidence recording spooled before the service restarts is retried after it', async () => {
        // This time the folder is there, without its marker.
        takeStorageRootAway();
        fs.mkdirSync(root);

        const id = await recordConsultation('RESTART');
        const spooled = await waitForFinalStatus(id, { apiUrl });

        expect(spooled.status).toBe('spooled');
        expect(spooled.error).toBe('store_failed: NO_STORAGE_ROOT_MARKER');
        expect(fs.readdirSync(root)).toEqual([]);

        // The storage root comes back while the service is down.
        docker('stop', container);
        makeStorageRoot(root);
        docker('start', container);

        // The service no longer knows the consultation; its evidence recording turns up in the storage root, and
        // leaves the spool.
        let location: string | undefined;

        await patient.driver.waitUntil(() => {
            location = findEvidence(root, id);

            return Boolean(location) && !fs.existsSync(path.join(spool, id));
        }, {
            interval: 500,
            timeout: 5 * retryMs + 30_000,
            timeoutMsg: 'the evidence recording spooled before the restart was not stored'
        });
        expectComplete(location ?? '', id);
    });
});
