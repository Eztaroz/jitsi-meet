import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, test } from 'node:test';

import { EvidenceRecording } from '../src/evidence.ts';

let hasFfmpeg = true;

try {
    execFileSync('ffmpeg', [ '-version' ], { stdio: 'ignore' });
    execFileSync('ffprobe', [ '-version' ], { stdio: 'ignore' });
} catch {
    hasFfmpeg = false;
}

/**
 * Finalises an evidence recording of one track whose raw file is `raw`, and returns the manifest's file entries.
 *
 * @param {string} name - The track's file name.
 * @param {Buffer} raw - What the track's chunks added up to.
 * @param {'audio'|'video'} kind - The track's kind.
 * @returns {Promise<Array<Record<string, unknown>>>}
 */
async function finaliseWith(
        name: string, raw: Buffer, kind: 'audio' | 'video'): Promise<Array<Record<string, unknown>>> {
    const spoolDir = await mkdtemp(path.join(tmpdir(), 'evidence-test-'));

    try {
        const evidence = new EvidenceRecording({ consultationId: 'c1', spoolDir, storageRoot: spoolDir });

        await evidence.open();
        await mkdir(path.join(spoolDir, 'c1', 'raw'), { recursive: true });
        await writeFile(path.join(spoolDir, 'c1', 'raw', name), raw);

        const at = new Date('2026-01-01T00:00:00Z');

        await evidence.finalise({
            consultationId: 'c1',
            end: at,
            hn: 'HN1',
            identities: [],
            participants: [],
            room: 'hn1',
            staffVisits: [],
            start: at,
            stopReason: 'room_destroyed',
            timeline: [],
            tracks: [ { endpointId: 'e1', file: name, kind, start: at, stop: at } ]
        });

        return JSON.parse(await readFile(path.join(spoolDir, 'c1', 'manifest.json'), 'utf8')).files;
    } finally {
        await rm(spoolDir, { force: true, recursive: true });
    }
}

/**
 * Makes two seconds of video from ffmpeg's test source, in the given encoder and container.
 *
 * @param {string} encoder - ffmpeg's encoder name.
 * @param {string} format - The container.
 * @returns {Buffer}
 */
function video(encoder: string, format: string): Buffer {
    return execFileSync('ffmpeg', [
        '-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=15:duration=2',
        '-c:v', encoder, '-f', format, '-'
    ], { maxBuffer: 64 * 1024 * 1024 });
}

describe('evidence recording: the manifest', { skip: !hasFfmpeg && 'ffmpeg and ffprobe are not on PATH' }, () => {
    test('records the codec of a video file copied as an IVF stream', async () => {
        const [ file ] = await finaliseWith('01-e1-video.webm', video('libvpx-vp9', 'ivf'), 'video');

        assert.equal(file.codec, 'vp9');
    });

    test('records VP8 for a video file recorded with MediaRecorder', async () => {
        const [ file ] = await finaliseWith('01-e1-video.webm', video('libvpx', 'webm'), 'video');

        assert.equal(file.codec, 'vp8');
    });

    test('records no codec for an audio file', async () => {
        const audio = execFileSync('ffmpeg', [
            '-v', 'error', '-f', 'lavfi', '-i', 'sine=duration=1', '-c:a', 'libopus', '-f', 'webm', '-'
        ], { maxBuffer: 64 * 1024 * 1024 });
        const [ file ] = await finaliseWith('01-e1-audio.webm', audio, 'audio');

        assert.equal(file.codec, undefined);
    });
});
