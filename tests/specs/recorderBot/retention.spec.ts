import { createHmac, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { docker, makeStorageRoot, retentionUnavailableReason } from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The retention sweeper deletes the evidence recordings whose consultation started longer ago than \
the retention period, and keeps the recent ones. It deletes the spool folders and staging leftovers in which nothing \
has changed for longer than that. It leaves alone, and logs, folders that do not match the evidence layout, and never \
deletes what a symbolic link in the storage root points to. Its logs name what it deletes by consultation id, never \
by HN. Skipped unless the recorderBot.available expectation and the RECORDER_BOT_ISOLATED_* variables are set.',
    usesBrowsers: [ 'p1' ]
});

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Writes a file, creating its folder.
 *
 * @param {string} file - The file.
 * @param {string} content - What to write.
 * @returns {void}
 */
function writeFile(file: string, content: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
}

/**
 * Sets the modification time of a folder and of everything in it, as if nothing had changed there since.
 *
 * @param {string} folder - The folder.
 * @param {Date} time - When.
 * @returns {void}
 */
function age(folder: string, time: Date) {
    for (const entry of fs.readdirSync(folder, { recursive: true }) as string[]) {
        fs.utimesSync(path.join(folder, entry), time, time);
    }
    fs.utimesSync(folder, time, time);
}

/**
 * Waits until a condition holds.
 *
 * @param {Function} condition - The condition.
 * @param {number} timeout - How long to wait, in milliseconds.
 * @param {string} description - What is awaited, for the failure message.
 * @returns {Promise<void>}
 */
async function waitFor(condition: () => boolean, timeout: number, description: string): Promise<void> {
    const deadline = Date.now() + timeout;

    while (!condition()) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

describe('Recorder bot: retention', () => {
    const {
        container = '',
        retentionDays,
        spool = '',
        storageRoot: root = '',
        sweepSeconds
    } = config.recorderBot.isolated;
    const run = `${Date.now()}`;
    const seededAt = new Date();
    const old = new Date(seededAt.getTime() - (retentionDays + 1) * DAY_MS);
    const recent = new Date(seededAt.getTime() - (retentionDays - 1) * DAY_MS);

    /**
     * One seeded evidence recording: its consultation, the HN in its manifest, where it is, and the part of its HN
     * that is unique to it.
     */
    interface ISeed {
        consultationId: string;
        folder: string;
        hn: string;
        room: string;
        tag: string;
    }

    /**
     * Seeds an evidence recording in the storage root, laid out as the service lays them out.
     *
     * @param {string} label - Distinguishes its HN.
     * @param {Date} start - Its consultation start.
     * @param {string} under - The folder its patient's folder is in; the storage root by default.
     * @returns {ISeed}
     */
    function seedEvidence(label: string, start: Date, under = root): ISeed {
        const tag = `retention${label}${run}`.toLowerCase();
        const hn = `HN/${tag}`.toUpperCase();
        const room = encodeURIComponent(hn.toLowerCase()).toLowerCase();
        const consultationId = randomUUID();
        const folder = path.join(under, room, start.toISOString().replace(/[-:]/g, ''));

        writeFile(path.join(folder, '01-endpoint-audio.webm'), 'media');
        writeFile(path.join(folder, 'timeline.json'), JSON.stringify({ consultationId, entries: [] }));
        writeFile(path.join(folder, 'manifest.json'), JSON.stringify({ consultationId, hn, room, start }));
        age(folder, start);

        return { consultationId, folder, hn, room, tag };
    }

    /**
     * Seeds a consultation folder as a crash leaves it in the spool, or in the staging folder.
     *
     * @param {string} dir - The spool, or the staging folder.
     * @param {Date} changed - When anything in it last changed.
     * @returns {Object} Its consultation, and where it is.
     */
    function seedLeftover(dir: string, changed: Date): { consultationId: string; folder: string; } {
        const consultationId = randomUUID();
        const folder = path.join(dir, consultationId);

        writeFile(path.join(folder, 'raw', '01-endpoint-video.webm'), 'media');
        age(folder, changed);

        return { consultationId, folder };
    }

    let oldEvidence: ISeed;
    let recentEvidence: ISeed;
    let unmatched: ISeed;
    let misplaced: ISeed;
    let linked: ISeed;
    let link: string;
    let staleSpool: { consultationId: string; folder: string; };
    let recentSpool: { consultationId: string; folder: string; };
    let staleStaging: { consultationId: string; folder: string; };

    after(() => {
        // What the sweeper kept, so that the next runs start clean.
        for (const seed of [ recentEvidence, unmatched, misplaced, linked ]) {
            if (seed) {
                fs.rmSync(path.dirname(seed.folder), { force: true, recursive: true });
            }
        }
        if (link) {
            fs.rmSync(link, { force: true });
            fs.rmSync(path.join(path.dirname(root), `outside-${run}`), { force: true, recursive: true });
        }
        if (recentSpool) {
            fs.rmSync(recentSpool.folder, { force: true, recursive: true });
        }
    });

    it('setup', async () => {
        const unavailable = retentionUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }
        makeStorageRoot(root);

        oldEvidence = seedEvidence('OLD', old);
        recentEvidence = seedEvidence('RECENT', recent);

        // Old, but not an evidence recording: a folder with no manifest.
        unmatched = seedEvidence('UNMATCHED', old);
        fs.rmSync(path.join(unmatched.folder, 'manifest.json'));
        age(unmatched.folder, old);

        // Old, but its manifest says it belongs elsewhere.
        misplaced = seedEvidence('MISPLACED', old);
        fs.renameSync(misplaced.folder, path.join(path.dirname(misplaced.folder), 'moved'));
        misplaced.folder = path.join(path.dirname(misplaced.folder), 'moved');

        // An old evidence recording outside the storage root, which a symbolic link in it points to. The link is
        // relative, so that it resolves both here and in the service's container.
        const outside = path.join(path.dirname(root), `outside-${run}`);

        linked = seedEvidence('LINKED', old, outside);
        link = path.join(root, linked.room);
        fs.symlinkSync(path.relative(root, path.join(outside, linked.room)), link);

        staleSpool = seedLeftover(spool, old);
        recentSpool = seedLeftover(spool, recent);
        staleStaging = seedLeftover(path.join(root, '.incoming'), old);

        await waitFor(() => !fs.existsSync(oldEvidence.folder) && !fs.existsSync(staleSpool.folder)
                && !fs.existsSync(staleStaging.folder),
            5 * sweepSeconds * 1000 + 10_000, 'the sweeper to delete the old folders');

        // Let one more sweep go by, which could still delete what it should not.
        await new Promise(resolve => setTimeout(resolve, 2 * sweepSeconds * 1000));
    });

    it('deletes the evidence recording older than the retention period, and keeps the recent one', () => {
        expect(fs.existsSync(oldEvidence.folder)).toBe(false);

        // Its patient's folder had nothing else in it.
        expect(fs.existsSync(path.dirname(oldEvidence.folder))).toBe(false);

        expect(fs.readdirSync(recentEvidence.folder).sort())
            .toEqual([ '01-endpoint-audio.webm', 'manifest.json', 'timeline.json' ]);
    });

    it('deletes the spool folders and staging leftovers in which nothing changed for longer than that', () => {
        expect(fs.existsSync(staleSpool.folder)).toBe(false);
        expect(fs.existsSync(staleStaging.folder)).toBe(false);
        expect(fs.existsSync(path.join(recentSpool.folder, 'raw', '01-endpoint-video.webm'))).toBe(true);
    });

    it('leaves alone folders that do not match the evidence layout, and what a symbolic link points to', () => {
        expect(fs.readdirSync(unmatched.folder).sort()).toEqual([ '01-endpoint-audio.webm', 'timeline.json' ]);
        expect(fs.existsSync(path.join(misplaced.folder, 'manifest.json'))).toBe(true);
        expect(fs.lstatSync(link).isSymbolicLink()).toBe(true);
        expect(fs.existsSync(path.join(linked.folder, 'manifest.json'))).toBe(true);
    });

    it('its logs name what it deletes by consultation id, and what it leaves alone without an HN', () => {
        const lines = docker('logs', '--since', seededAt.toISOString(), container)
            .split('\n')
            .flatMap(line => {
                try {
                    return [ JSON.parse(line) as Record<string, string> ];
                } catch {
                    return [];
                }
            });
        const deleted = lines.filter(l => l.message === 'deleted a folder older than the retention period');
        const left = lines.filter(l => l.message === 'leaving alone a folder that does not match the evidence layout');
        // The service keys the references with its control API's bearer secret (recorder-bot/deploy/README.md,
        // Retention).
        const ref = (relative: string) => createHmac('sha256', config.recorderBot.apiSecret ?? '')
            .update(relative)
            .digest('hex')
            .slice(0, 16);

        expect(deleted.map(l => [ l.consultationId, l.place ]).sort()).toEqual([
            [ oldEvidence.consultationId, 'storage_root' ],
            [ staleSpool.consultationId, 'spool' ],
            [ staleStaging.consultationId, 'staging' ]
        ].sort());
        expect(left.map(l => l.folder)).toEqual(expect.arrayContaining([
            ref(path.posix.join(unmatched.room, path.basename(unmatched.folder))),
            ref(path.posix.join(misplaced.room, 'moved')),
            ref(linked.room)
        ]));

        const all = lines.map(l => JSON.stringify(l)).join('\n').toLowerCase();

        for (const seed of [ oldEvidence, recentEvidence, unmatched, misplaced, linked ]) {
            expect(all).not.toContain(seed.tag);
        }
    });
});
