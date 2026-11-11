import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { EvidenceRecording, STORAGE_ROOT_MARKER, evidenceLocation } from '../src/evidence.ts';

const CONSULTATION_START = new Date('2026-05-01T08:00:00Z');

describe('an evidence recording made of the parts of more than one recorder bot (ADR 0016)', () => {
    let root: string;
    let storage: string;

    beforeEach(async () => {
        root = await mkdtemp(path.join(tmpdir(), 'parts-test-'));
        storage = path.join(root, 'storage');
        await mkdir(storage);
        await writeFile(path.join(storage, STORAGE_ROOT_MARKER), '');
    });
    afterEach(() => rm(root, { force: true, recursive: true }));

    /**
     * Records a part as a recorder bot on its own VM does: its own spool, the same storage root.
     *
     * @param {string} part - The recorder bot's id.
     * @param {Object} times - When the part started and ended, and the gap in front of it if it was a takeover.
     * @returns {Promise<string>} Where the part was stored, in the storage root.
     */
    async function recordPart(part: string, times: { awaiting?: string[]; end: string; gap?: [string, string]; start: string; }): Promise<string> {
        const spoolDir = path.join(root, `spool-${part}`);
        const evidence = new EvidenceRecording({ consultationId: 'c1', spoolDir, storageRoot: storage });
        const at = new Date(times.start);

        await evidence.open();
        await evidence.finalise({
            awaitingParts: times.awaiting,
            consultationId: 'c1',
            consultationStart: CONSULTATION_START,
            end: new Date(times.end),
            hn: 'HN/1',
            identities: [],
            participants: [],
            part,
            room: 'hn%2f1',
            staffVisits: [],
            start: at,
            stopReason: 'room_destroyed',
            timeline: times.gap
                ? [ { at: new Date(times.gap[1]), end: new Date(times.gap[1]), start: new Date(times.gap[0]), type: 'gap' } ]
                : [],
            tracks: []
        });

        const location = evidenceLocation('hn%2f1', CONSULTATION_START, part);

        await evidence.store(location);

        return location;
    }

    test('names each part\'s folder under the consultation\'s, so that parts never overwrite each other', async () => {
        const first = await recordPart('bot-1', { end: '2026-05-01T08:30:00Z', start: '2026-05-01T08:00:01Z' });
        const second = await recordPart('bot-2', { end: '2026-05-01T09:00:00Z', start: '2026-05-01T08:31:00Z' });

        assert.equal(first, 'hn%2f1/20260501T080000.000Z/bot-1');
        assert.equal(second, 'hn%2f1/20260501T080000.000Z/bot-2');
        assert.deepEqual((await readdir(path.join(storage, 'hn%2f1', '20260501T080000.000Z'))).sort(),
            [ 'bot-1', 'bot-2', 'manifest.json' ]);
    });

    test('lists every part in the consultation\'s manifest, with the gap the takeover left', async () => {
        await recordPart('bot-1', { end: '2026-05-01T08:30:00Z', start: '2026-05-01T08:00:01Z' });
        await recordPart('bot-2', {
            end: '2026-05-01T09:00:00Z',
            gap: [ '2026-05-01T08:29:50Z', '2026-05-01T08:31:00Z' ],
            start: '2026-05-01T08:31:00Z'
        });

        const manifest = JSON.parse(await readFile(
            path.join(storage, 'hn%2f1', '20260501T080000.000Z', 'manifest.json'), 'utf8'));

        assert.equal(manifest.consultationId, 'c1');
        assert.equal(manifest.room, 'hn%2f1');
        assert.equal(manifest.start, '2026-05-01T08:00:00.000Z');
        assert.equal(manifest.end, '2026-05-01T09:00:00.000Z');
        assert.deepEqual(manifest.parts.map((p: { part: string; }) => p.part), [ 'bot-1', 'bot-2' ]);
        assert.deepEqual(manifest.gaps, [ { end: '2026-05-01T08:31:00.000Z', start: '2026-05-01T08:29:50.000Z' } ]);
    });

    describe('while a lost worker\'s part is still in its spool', () => {
        const manifestPath = () => path.join(storage, 'hn%2f1', '20260501T080000.000Z', 'manifest.json');

        test('says the evidence recording is incomplete, and complete once the part has arrived', async () => {
            await recordPart('bot-2', {
                awaiting: [ 'bot-1' ],
                end: '2026-05-01T09:00:00Z',
                gap: [ '2026-05-01T08:29:50Z', '2026-05-01T08:31:00Z' ],
                start: '2026-05-01T08:31:00Z'
            });

            const incomplete = JSON.parse(await readFile(manifestPath(), 'utf8'));

            assert.equal(incomplete.complete, false);
            assert.deepEqual(incomplete.missingParts, [ 'bot-1' ]);
            assert.deepEqual(incomplete.parts.map((p: { part: string; }) => p.part), [ 'bot-2' ]);

            // The VM comes back: its spool moves the part into the storage root.
            await recordPart('bot-1', { end: '2026-05-01T08:30:00Z', start: '2026-05-01T08:00:01Z' });

            const complete = JSON.parse(await readFile(manifestPath(), 'utf8'));

            assert.equal(complete.complete, true);
            assert.deepEqual(complete.missingParts, []);
            assert.deepEqual(complete.parts.map((p: { part: string; }) => p.part), [ 'bot-1', 'bot-2' ]);
        });

        test('is complete when every part is stored and none is awaited', async () => {
            await recordPart('bot-1', { end: '2026-05-01T08:30:00Z', start: '2026-05-01T08:00:01Z' });

            const manifest = JSON.parse(await readFile(manifestPath(), 'utf8'));

            assert.equal(manifest.complete, true);
            assert.deepEqual(manifest.missingParts, []);
        });

        test('stays incomplete when a part that arrives itself awaits another one (two takeovers in a row)', async () => {
            await recordPart('bot-3', { awaiting: [ 'bot-2' ], end: '2026-05-01T10:00:00Z', start: '2026-05-01T09:31:00Z' });
            await recordPart('bot-2', { awaiting: [ 'bot-1' ], end: '2026-05-01T09:30:00Z', start: '2026-05-01T08:31:00Z' });

            const manifest = JSON.parse(await readFile(manifestPath(), 'utf8'));

            assert.equal(manifest.complete, false);
            assert.deepEqual(manifest.missingParts, [ 'bot-1' ]);
        });
    });

    test('keeps a part\'s own manifest and timeline in its folder, with the gap in the timeline', async () => {
        await recordPart('bot-2', {
            end: '2026-05-01T09:00:00Z',
            gap: [ '2026-05-01T08:29:50Z', '2026-05-01T08:31:00Z' ],
            start: '2026-05-01T08:31:00Z'
        });

        const folder = path.join(storage, 'hn%2f1', '20260501T080000.000Z', 'bot-2');
        const timeline = JSON.parse(await readFile(path.join(folder, 'timeline.json'), 'utf8'));
        const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8'));

        assert.equal(timeline.entries[0].type, 'gap');
        assert.equal(manifest.part, 'bot-2');
        assert.equal(manifest.consultationStart, '2026-05-01T08:00:00.000Z');
    });
});
