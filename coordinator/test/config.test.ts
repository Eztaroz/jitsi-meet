import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig, loadLayout } from '../src/config.ts';

/**
 * Writes a rooms file.
 *
 * @param {unknown} content - Its JSON.
 * @returns {string} Its path.
 */
function roomsFile(content: unknown): string {
    const file = join(mkdtempSync(join(tmpdir(), 'layout-')), 'rooms.json');

    writeFileSync(file, JSON.stringify(content));

    return file;
}

describe('the rooms file', () => {
    const center = (stations: unknown[]) => ({ centers: [ { id: 'center-1', stations } ] });

    it('has no center when no file is configured', () => {
        assert.deepEqual(loadLayout(undefined), { centers: [] });
    });

    it('reads the center, with each station\'s stage and lounge', () => {
        const stations = [
            { id: 'intake', lounge: 'lounge-intake', stage: 'intake' },
            { id: 'examination', lounge: 'lounge-examination', stage: 'examination' },
            { id: 'aftercare', lounge: 'lounge-aftercare', stage: 'aftercare' }
        ];

        assert.deepEqual(loadLayout(roomsFile(center(stations))), center(stations));
    });

    it('refuses the format of station rooms, and says why', () => {
        const old = { lounges: [ { room: 'lounge-1' } ], stations: [ { room: 'intake-1', stage: 'intake' } ] };

        assert.throws(() => loadLayout(roomsFile(old)), /ADR 0011/u);
    });

    it('needs exactly one center, for now', () => {
        assert.throws(() => loadLayout(roomsFile({ centers: [] })), /exactly one center/u);
        assert.throws(() => loadLayout(roomsFile({
            centers: [ { id: 'a', stations: [] }, { id: 'b', stations: [] } ]
        })), /exactly one center/u);
    });

    it('refuses a station without a known stage', () => {
        assert.throws(() => loadLayout(roomsFile(center([ { id: 'x', lounge: 'l', stage: 'waiting' } ]))), /stage/u);
    });

    it('refuses a station without an id or a lounge', () => {
        assert.throws(() => loadLayout(roomsFile(center([ { lounge: 'l', stage: 'intake' } ]))), /"id"/u);
        assert.throws(() => loadLayout(roomsFile(center([ { id: 'x', stage: 'intake' } ]))), /"lounge"/u);
    });

    it('reads the waiting videos of the catalogue', () => {
        const videos = [ { file: 'videos/intro.mp4', id: 'intro', title: 'Intro' } ];

        assert.deepEqual(loadLayout(roomsFile({ ...center([]), videos })).videos, videos);
    });

    it('refuses a waiting video without an id, a title or a file, or two with one id', () => {
        const video = { file: 'a.mp4', id: 'a', title: 'A' };

        for (const missing of [ 'id', 'title', 'file' ]) {
            assert.throws(() => loadLayout(roomsFile({ ...center([]), videos: [ { ...video, [missing]: '' } ] })),
                new RegExp(`"${missing}"`, 'u'));
        }
        assert.throws(() => loadLayout(roomsFile({ ...center([]), videos: [ video, video ] })), /two videos are "a"/u);
        assert.throws(() => loadLayout(roomsFile({ ...center([]), videos: 'x' })), /"videos" must be a list/u);
    });

    it('refuses a stage whose default video is not in the catalogue', () => {
        const stages = [ { id: 'waiting', name: 'W', defaultVideo: 'nope' }, { id: 'done', name: 'D' } ];
        const withVideos = (videos?: unknown) => roomsFile({
            centers: [ { id: 'c', pathways: [ { id: 'p', stages } ], stations: [] } ],
            ...videos ? { videos } : {}
        });

        assert.throws(() => loadLayout(withVideos([ { file: 'a.mp4', id: 'intro', title: 'Intro' } ])),
            /stage "waiting" of pathway "p".*"nope"/u);
        assert.throws(() => loadLayout(withVideos()), /"nope"/u);
        assert.doesNotThrow(() => loadLayout(withVideos([ { file: 'a.mp4', id: 'nope', title: 'N' } ])));
    });

    it('refuses two stations with one id, or with one lounge whatever its case', () => {
        assert.throws(() => loadLayout(roomsFile(center([
            { id: 'x', lounge: 'a', stage: 'intake' }, { id: 'x', lounge: 'b', stage: 'aftercare' }
        ]))), /two stations are "x"/u);
        assert.throws(() => loadLayout(roomsFile(center([
            { id: 'x', lounge: 'Lounge', stage: 'intake' }, { id: 'y', lounge: 'lounge', stage: 'aftercare' }
        ]))), /lounge/u);
    });
});

describe('the settings', () => {
    const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        COORDINATOR_API_SECRET: 'secret',
        COORDINATOR_PROSODY_URL: 'http://prosody:5280',
        COORDINATOR_RECORDER_BOT_SECRET: 'bot-secret',
        COORDINATOR_RECORDER_BOT_URL: 'http://bot:8090',
        COORDINATOR_SIGNING_KEY_FILE: roomsFile({}),
        COORDINATOR_SIGNING_KID: 'kid',
        COORDINATOR_TOKEN_SUBJECT: 'meet.example',
        ...extra
    });

    it('read the rooms file from COORDINATOR_ROOMS_FILE', () => {
        const file = roomsFile({ centers: [ { id: 'center-1', stations: [] } ] });

        assert.deepEqual(loadConfig(env({ COORDINATOR_ROOMS_FILE: file })).layout, { centers: [ { id: 'center-1', stations: [] } ] });
    });

    it('turn the video player on with its URL, secret, marker and the base URL of the videos', () => {
        const config = loadConfig(env({
            COORDINATOR_VIDEO_BASE_URL: 'https://meet.example/',
            COORDINATOR_VIDEO_PLAYER_MARKER: 'user.hospital_role=video_player',
            COORDINATOR_VIDEO_PLAYER_SECRET: 'vp-secret',
            COORDINATOR_VIDEO_PLAYER_URL: 'http://video-player:8091/'
        }));

        assert.deepEqual(config.videoPlayer, { baseUrl: 'https://meet.example/', secret: 'vp-secret', url: 'http://video-player:8091' });
        assert.deepEqual(config.roleMarkers.videoPlayer, { path: [ 'user', 'hospital_role' ], value: 'video_player' });
    });

    it('refuse a video player URL without the video player marker', () => {
        assert.throws(() => loadConfig(env({
            COORDINATOR_VIDEO_BASE_URL: 'https://meet.example/',
            COORDINATOR_VIDEO_PLAYER_SECRET: 'vp-secret',
            COORDINATOR_VIDEO_PLAYER_URL: 'http://video-player:8091/'
        })), /COORDINATOR_VIDEO_PLAYER_MARKER/u);
    });

    it('have no video player without its URL, and refuse a half-set one', () => {
        assert.equal(loadConfig(env()).videoPlayer, undefined);
        assert.throws(() => loadConfig(env({ COORDINATOR_VIDEO_PLAYER_URL: 'http://vp:8091' })), /COORDINATOR_VIDEO_BASE_URL must be set/u);
    });
});
