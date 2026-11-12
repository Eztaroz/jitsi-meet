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

/** The codecs the recorder bot copies from the sender, as ffprobe names them, and the ffmpeg encoder that makes each. */
const ENCODERS = {
    av1: [ '-c:v', 'libaom-av1', '-cpu-used', '8', '-b:v', '100k' ],
    vp8: [ '-c:v', 'libvpx', '-b:v', '100k' ],
    vp9: [ '-c:v', 'libvpx-vp9', '-b:v', '100k' ]
} as const;

type Codec = keyof typeof ENCODERS;

/**
 * Whether this machine's ffmpeg can make video of a codec, to build the test evidence with.
 *
 * @param {Codec} codec - The codec.
 * @returns {boolean}
 */
function canMake(codec: Codec): boolean {
    try {
        return execFileSync('ffmpeg', [ '-hide_banner', '-encoders' ], { encoding: 'utf8' })
            .includes(` ${ENCODERS[codec][1]} `);
    } catch {
        return false;
    }
}

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
 * @param {Function} codecOf - The codec of the video file made for the nth video span (from 0), as the sender used it.
 * @returns {Promise<void>}
 */
async function buildEvidence(folder: string, codecOf: (nth: number) => Codec = () => 'vp8'): Promise<void> {
    await mkdir(folder, { recursive: true });

    const files: Array<{
        bytes: number;
        codec?: string;
        duration: number;
        endpointId: string;
        kind: string;
        name: string;
        start: string;
        stop: string;
    }> = [];
    let count = 0;
    let nth = 0;

    for (const person of PEOPLE) {
        for (const span of person.spans) {
            const duration = span.to - span.from;
            const video = `${String(++count).padStart(2, '0')}-${span.endpoint}-video.webm`;
            const audio = `${String(++count).padStart(2, '0')}-${span.endpoint}-audio.webm`;
            const codec = codecOf(nth++);

            await execFileAsync('ffmpeg', [
                '-hide_banner', '-loglevel', 'error', '-y',
                '-f', 'lavfi', '-i', `testsrc=size=160x120:rate=15:duration=${duration}`,
                '-f', 'lavfi', '-i', `sine=frequency=440:duration=${duration}`,
                '-map', '0:v', ...ENCODERS[codec], path.join(folder, video),
                '-map', '1:a', '-c:a', 'libopus', path.join(folder, audio)
            ]);
            for (const [ name, kind ] of [ [ video, 'video' ], [ audio, 'audio' ] ]) {
                files.push({
                    bytes: (await stat(path.join(folder, name))).size,
                    ...kind === 'video' ? { codec } : {},
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

/**
 * Renders an evidence recording and checks the result is the whole consultation as one H.264 MP4 with sound, and that
 * every video span reached the picture: a tile whose codec ffmpeg could not decode would fail the render.
 *
 * @param {string} folder - The evidence recording.
 * @param {string} output - The Review file.
 * @returns {Promise<void>}
 */
async function assertRendered(folder: string, output: string): Promise<void> {
    const { code, stderr } = await review(folder, output);

    assert.equal(code, 0, stderr);

    const { stdout } = await execFileAsync('ffprobe', [
        '-v', 'error', '-show_entries', 'format=duration:stream=codec_type,codec_name,width,height', '-of', 'json', output
    ]);
    const probe = JSON.parse(stdout) as {
        format: { duration: string; };
        streams: Array<{ codec_name: string; codec_type: string; height?: number; width?: number; }>;
    };

    assert.ok(Math.abs(Number(probe.format.duration) - LENGTH) < 0.3, `duration ${probe.format.duration}`);
    assert.deepEqual(
        probe.streams.map(s => [ s.codec_type, s.codec_name, s.width, s.height ]).sort(),
        [ [ 'audio', 'aac', undefined, undefined ], [ 'video', 'h264', 1280, 720 ] ]);
}

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

    ([ 'av1', 'vp9', 'vp8' ] as const).forEach(codec => {
        test(`renders a Review file from ${codec} video tracks`, {
            skip: !canMake(codec) && `ffmpeg has no ${codec} encoder`
        }, async () => {
            const folder = path.join(work, `only-${codec}`);

            await buildEvidence(folder, () => codec);
            await assertRendered(folder, path.join(work, `only-${codec}.mp4`));
        });
    });

    test('renders a Review file from AV1, VP9 and VP8 tracks mixed in one consultation', {
        skip: !(canMake('av1') && canMake('vp9') && canMake('vp8')) && 'ffmpeg lacks an AV1, VP9 or VP8 encoder'
    }, async () => {
        const codecs: Codec[] = [ 'av1', 'vp9', 'vp8', 'av1', 'vp9' ];
        const folder = path.join(work, 'mixed');

        await buildEvidence(folder, nth => codecs[nth % codecs.length]);

        const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')) as {
            files: Array<{ codec?: string; }>;
        };

        assert.deepEqual([ ...new Set(manifest.files.flatMap(file => file.codec ?? [])) ].sort(), [ 'av1', 'vp8', 'vp9' ]);
        await assertRendered(folder, path.join(work, 'mixed.mp4'));
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
