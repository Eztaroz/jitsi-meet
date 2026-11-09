import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { promisify } from 'node:util';

import { outsideGaps } from '../src/reviewRender.ts';

const execFileAsync = promisify(execFile);

const START = '2026-11-02T16:00:00.000Z';
const LENGTH = 8;
const COMMAND = path.join(import.meta.dirname, '..', 'src', 'review.ts');

/** Where fontconfig is not set up, as on Windows, the command needs a font file. */
const FONT = process.platform === 'win32' ? [ '--font', path.join(process.env.WINDIR ?? 'C:\\Windows', 'Fonts', 'tahoma.ttf') ] : [];

const hasFfmpeg = (() => {
    try {
        execFileSync('ffmpeg', [ '-version' ], { stdio: 'ignore' });
        execFileSync('ffprobe', [ '-version' ], { stdio: 'ignore' });

        return true;
    } catch {
        return false;
    }
})();

/**
 * Returns the ISO time `seconds` after the consultation started.
 *
 * @param {number} seconds - Offset from the start.
 * @returns {string}
 */
function at(seconds: number): string {
    return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

/** Who was there: each span is one recorded video file and one audio file, on the endpoint named. */
const PEOPLE = [
    {
        id: 'nurse-1',
        name: 'Nurse 100%',
        role: 'staff',
        spans: [ { endpoint: 'n0', from: 0, to: 5 }, { endpoint: 'n0', from: 6, to: 8 } ]
    },
    {
        // Joins late, leaves and comes back on a new endpoint, and is cut by the gap.
        id: 'patient-1',
        name: 'สมชาย ใจดี',
        role: 'patient',
        spans: [ { endpoint: 'p0', from: 2, to: 3.5 }, { endpoint: 'p1', from: 4, to: 5 }, { endpoint: 'p1', from: 6, to: 8 } ]
    }
];

/** The bot crashed at 5 seconds and was back at 6. */
const GAPS = [ { start: at(5), end: at(6) } ];

/**
 * Builds a small evidence recording, as the recorder bot finalises one, with ffmpeg's test sources.
 *
 * @param {string} folder - Where.
 * @returns {Promise<void>}
 */
async function buildEvidence(folder: string): Promise<void> {
    await mkdir(folder, { recursive: true });

    const files: Array<{
        bytes: number;
        duration: number;
        endpointId: string;
        kind: string;
        name: string;
        start: string;
        stop: string;
    }> = [];
    let count = 0;

    for (const person of PEOPLE) {
        for (const span of person.spans) {
            const duration = span.to - span.from;
            const video = `${String(++count).padStart(2, '0')}-${span.endpoint}-video.webm`;
            const audio = `${String(++count).padStart(2, '0')}-${span.endpoint}-audio.webm`;

            await execFileAsync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=15:duration=${duration}`,
                '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
                '-map', '0:v', '-c:v', 'libvpx', '-b:v', '100k', path.join(folder, video),
                '-map', '1:a', '-c:a', 'libopus', path.join(folder, audio)
            ]);
            for (const [ name, kind ] of [ [ video, 'video' ], [ audio, 'audio' ] ]) {
                files.push({
                    bytes: (await stat(path.join(folder, name))).size,
                    duration,
                    endpointId: span.endpoint,
                    kind,
                    name,
                    start: at(span.from),
                    stop: at(span.to)
                });
            }
        }
    }

    await writeFile(path.join(folder, 'timeline.json'), JSON.stringify({ consultationId: 'c1', entries: [] }));
    await writeFile(path.join(folder, 'manifest.json'), JSON.stringify({
        consultationId: 'c1',
        hn: 'HN-TEST',
        room: 'hn-test',
        start: START,
        end: at(LENGTH),
        stopReason: 'room_destroyed',
        participants: [],
        identities: PEOPLE.map(person => ({
            endpointIds: [ ...new Set(person.spans.map(span => span.endpoint)) ],
            files: files.filter(file => person.spans.some(span => span.endpoint === file.endpointId)).map(f => f.name),
            identity: { id: person.id, name: person.name },
            role: person.role
        })),
        files,
        staffVisits: [],
        gaps: GAPS
    }));
}

/**
 * Hashes every file in a folder, by name.
 *
 * @param {string} folder - The folder.
 * @returns {Promise<Record<string, string>>}
 */
async function hashes(folder: string): Promise<Record<string, string>> {
    const result: Record<string, string> = {};

    for (const entry of await readdir(folder, { recursive: true, withFileTypes: true })) {
        if (entry.isFile()) {
            const file = path.join(entry.parentPath, entry.name);

            result[path.relative(folder, file)] = createHash('sha256').update(await readFile(file)).digest('hex');
        }
    }

    return result;
}

/**
 * Runs the command.
 *
 * @param {string[]} args - Its arguments.
 * @returns {Promise<{ code: number; stderr: string; }>}
 */
async function review(...args: string[]): Promise<{ code: number; stderr: string; }> {
    try {
        const { stderr } = await execFileAsync(process.execPath, [ COMMAND, ...FONT, ...args ]);

        return { code: 0, stderr };
    } catch (error) {
        const { code, stderr } = error as { code: number; stderr: string; };

        return { code, stderr };
    }
}

describe('outsideGaps', () => {
    test('cuts the gaps out of the spans', () => {
        assert.deepEqual(outsideGaps([ { from: 0, to: 10 }, { from: 12, to: 14 } ], [ { from: 3, to: 5 }, { from: 11, to: 13 } ]), [
            { from: 0, to: 3 },
            { from: 5, to: 10 },
            { from: 13, to: 14 }
        ]);
    });
});

describe('npm run review', { skip: !hasFfmpeg && 'ffmpeg and ffprobe are not on PATH' }, () => {
    let work: string;
    let evidence: string;

    before(async () => {
        work = await mkdtemp(path.join(os.tmpdir(), 'review-test-'));
        evidence = path.join(work, 'hn-test', '20261102T160000.000Z');
        await buildEvidence(evidence);
    });
    after(() => rm(work, { force: true, recursive: true }));

    test('renders the whole consultation as one 1280x720 MP4 and leaves the evidence untouched', async () => {
        const untouched = await hashes(evidence);
        const output = path.join(work, 'review.mp4');
        const { code, stderr } = await review(evidence, output);

        assert.equal(code, 0, stderr);

        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_type,codec_name,width,height',
            '-of', 'json', output
        ]);
        const probe = JSON.parse(stdout) as {
            format: { duration: string; format_name: string; };
            streams: Array<{ codec_name: string; codec_type: string; height?: number; width?: number; }>;
        };

        assert.match(probe.format.format_name, /mp4/);
        assert.ok(Math.abs(Number(probe.format.duration) - LENGTH) < 0.3, `duration ${probe.format.duration}`);
        assert.deepEqual(probe.streams.map(s => s.codec_type).sort(), [ 'audio', 'video' ]);
        assert.deepEqual(
            probe.streams.filter(s => s.codec_type === 'video').map(s => [ s.codec_name, s.width, s.height ]),
            [ [ 'h264', 1280, 720 ] ]);
        assert.deepEqual(probe.streams.filter(s => s.codec_type === 'audio').map(s => s.codec_name), [ 'aac' ]);
        assert.deepEqual(await hashes(evidence), untouched);
        assert.deepEqual(await readdir(work).then(names => names.filter(n => n.endsWith('.part'))), []);
    });

    test('refuses a folder that is not a finalised evidence recording', async () => {
        const unfinished = path.join(work, 'unfinished');

        await mkdir(unfinished, { recursive: true });

        const { code, stderr } = await review(unfinished, path.join(work, 'unfinished.mp4'));

        assert.equal(code, 1);
        assert.match(stderr, /not a finalised evidence recording/);
    });

    test('refuses an output file inside the evidence recording folder', async () => {
        const untouched = await hashes(evidence);

        for (const output of [ path.join(evidence, 'review.mp4'), path.join(evidence, '.', 'review.mp4') ]) {
            const { code, stderr } = await review(evidence, output);

            assert.equal(code, 1);
            assert.match(stderr, /inside the evidence recording folder/);
        }
        assert.deepEqual(await hashes(evidence), untouched);
    });

    test('prints its usage without two paths', async () => {
        const { code, stderr } = await review(evidence);

        assert.equal(code, 2);
        assert.match(stderr, /usage/);
    });
});
