import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, test } from 'node:test';

import type { Consultations } from '../src/consultations.ts';
import { STORAGE_ROOT_MARKER, evidenceLocation } from '../src/evidence.ts';
import { RetentionSweeper } from '../src/retention.ts';

const DAY_MS = 86_400_000;
const OLD_ID = '11111111-1111-1111-1111-111111111111';
const STALE_ID = '22222222-2222-2222-2222-222222222222';

describe('the retention sweeper and which recorder bot sweeps the evidence storage root', () => {
    let base = '';
    let spoolDir = '';
    let storageRoot = '';

    /**
     * Puts an evidence recording, old enough to be deleted, in the storage root.
     *
     * @returns {Promise<string>} Its folder.
     */
    async function putOldEvidence(): Promise<string> {
        const start = new Date(Date.now() - 100 * DAY_MS);
        const folder = path.join(storageRoot, evidenceLocation('HN-1', start));

        await mkdir(folder, { recursive: true });
        await writeFile(path.join(folder, 'manifest.json'),
            JSON.stringify({ consultationId: OLD_ID, room: 'HN-1', start: start.toISOString() }));

        return folder;
    }

    /**
     * Puts a consultation folder nothing has changed in for 100 days in the spool.
     *
     * @returns {Promise<string>} Its folder.
     */
    async function putStaleSpoolFolder(): Promise<string> {
        const folder = path.join(spoolDir, STALE_ID);
        const old = new Date(Date.now() - 100 * DAY_MS);

        await mkdir(folder, { recursive: true });
        await utimes(folder, old, old);

        return folder;
    }

    const exists = (file: string) => import('node:fs/promises').then(fs => fs.lstat(file)).then(() => true, () => false);

    const make = (mayEmptyStorageRoot?: () => boolean) => new RetentionSweeper({
        consultations: { get: () => undefined } as unknown as Consultations,
        folderRefKey: 'key',
        mayEmptyStorageRoot,
        retentionMs: 90 * DAY_MS,
        spoolDir,
        storageRoot
    });

    beforeEach(async () => {
        base = await mkdtemp(path.join(tmpdir(), 'retention-test-'));
        spoolDir = path.join(base, 'spool');
        storageRoot = path.join(base, 'evidence');
        await mkdir(spoolDir);
        await mkdir(storageRoot);
        await writeFile(path.join(storageRoot, STORAGE_ROOT_MARKER), '');
    });
    afterEach(() => rm(base, { force: true, recursive: true }));

    test('deletes an evidence recording past the retention period, when nothing says it may not', async () => {
        const folder = await putOldEvidence();

        await make().sweep();
        assert.equal(await exists(folder), false);
    });

    test('deletes an evidence recording past the retention period while it is the one named to sweep', async () => {
        const folder = await putOldEvidence();

        await make(() => true).sweep();
        assert.equal(await exists(folder), false);
    });

    test('leaves the evidence storage root alone when it is not the one named, but still sweeps its own spool', async () => {
        const evidence = await putOldEvidence();
        const spool = await putStaleSpoolFolder();

        await make(() => false).sweep();
        assert.equal(await exists(evidence), true);
        assert.equal(await exists(spool), false);
    });

    test('asks again at every sweep, so that it sweeps once named', async () => {
        const evidence = await putOldEvidence();
        let named = false;
        const sweeper = make(() => named);

        await sweeper.sweep();
        assert.equal(await exists(evidence), true);

        named = true;
        await sweeper.sweep();
        assert.equal(await exists(evidence), false);
    });
});
