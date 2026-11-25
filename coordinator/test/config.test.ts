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

        assert.deepEqual(loadLayout(roomsFile(center(stations))), center(stations.map(({ stage, ...s }) => ({
            ...s, stages: [ stage ]
        }))));
    });

    it('reads a station that serves several stages (ADR 0018)', () => {
        const nurse = { id: 'nurse', lounge: 'lounge-nurse', stages: [ 'intake', 'aftercare' ] };

        assert.deepEqual(loadLayout(roomsFile(center([ nurse ]))), center([ nurse ]));
    });

    it('lets two stations serve one stage, as before', () => {
        const stations = [
            { id: 'nurse', lounge: 'lounge-nurse', stages: [ 'intake', 'aftercare' ] },
            { id: 'aftercare', lounge: 'lounge-aftercare', stages: [ 'aftercare' ] }
        ];

        assert.deepEqual(loadLayout(roomsFile(center(stations))).centers[0].stations, stations);
    });

    it('refuses examination with another stage in one station, and says why', () => {
        assert.throws(() => loadLayout(roomsFile(center([
            { id: 'x', lounge: 'l', stages: [ 'intake', 'examination' ] }
        ]))), /station "x".*"examination".*per doctor/u);
    });

    it('refuses a station with both "stage" and "stages", an empty or repeated "stages", or an unknown stage in it', () => {
        for (const station of [
            { id: 'x', lounge: 'l', stage: 'intake', stages: [ 'aftercare' ] },
            { id: 'x', lounge: 'l', stages: [] },
            { id: 'x', lounge: 'l', stages: 'intake' },
            { id: 'x', lounge: 'l', stages: [ 'intake', 'intake' ] },
            { id: 'x', lounge: 'l', stages: [ 'intake', 'done' ] },
            { id: 'x', lounge: 'l', stages: [ 'intake', 'nope' ] }
        ]) {
            assert.throws(() => loadLayout(roomsFile(center([ station ]))), /station "x"/u, JSON.stringify(station));
        }
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

    it('reads the HIS clinic codes of a clinic (ADR 0019)', () => {
        const layout = { centers: [ {
            clinics: [ { hisCodes: [ 'GYN', 'GY2' ], id: 'gyn' }, { id: 'med' } ], id: 'center-1',
            stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ]
        } ] };

        assert.deepEqual(loadLayout(roomsFile(layout)).centers[0].clinics, layout.centers[0].clinics);
    });

    it('refuses HIS clinic codes that are not a list of codes, or a code in two clinics', () => {
        const withClinics = (clinics: unknown[]) => roomsFile({ centers: [ {
            clinics, id: 'center-1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ]
        } ] });

        assert.throws(() => loadLayout(withClinics([ { hisCodes: 'GYN', id: 'gyn' } ])), /clinic "gyn": "hisCodes" must be a list/u);
        assert.throws(() => loadLayout(withClinics([ { hisCodes: [ '' ], id: 'gyn' } ])), /"hisCodes" must be a list/u);
        assert.throws(() => loadLayout(withClinics([ { hisCodes: [ 'GYN' ], id: 'gyn' }, { hisCodes: [ 'GYN' ], id: 'gyn2' } ])),
            /the HIS clinic code "GYN" is in two clinics/u);
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

        assert.deepEqual(config.videoPlayer, {
            baseUrl: 'https://meet.example/',
            playTimeoutMs: 45_000,
            workers: [ { id: 'video-player', secret: 'vp-secret', url: 'http://video-player:8091' } ]
        });
        assert.deepEqual(config.roleMarkers.videoPlayer, { path: [ 'user', 'hospital_role' ], value: 'video_player' });
    });

    it('let the wait for a video to start be set, in seconds', () => {
        const config = loadConfig(env({
            COORDINATOR_VIDEO_BASE_URL: 'https://meet.example/',
            COORDINATOR_VIDEO_PLAYER_MARKER: 'user.hospital_role=video_player',
            COORDINATOR_VIDEO_PLAYER_SECRET: 'vp-secret',
            COORDINATOR_VIDEO_PLAYER_URL: 'http://video-player:8091/',
            COORDINATOR_VIDEO_PLAY_TIMEOUT_SECONDS: '90'
        }));

        assert.equal(config.videoPlayer?.playTimeoutMs, 90_000);
    });

    it('refuse a video player URL without the video player marker', () => {
        assert.throws(() => loadConfig(env({
            COORDINATOR_VIDEO_BASE_URL: 'https://meet.example/',
            COORDINATOR_VIDEO_PLAYER_SECRET: 'vp-secret',
            COORDINATOR_VIDEO_PLAYER_URL: 'http://video-player:8091/'
        })), /COORDINATOR_VIDEO_PLAYER_MARKER/u);
    });

    it('keep the state in SQLite, in the data directory, unless a MariaDB host is set', () => {
        assert.equal(loadConfig(env()).database, undefined);
    });

    it('keep the state in MariaDB when its host is set, and refuse a half-set one', () => {
        const mariadb = {
            COORDINATOR_MARIADB_DATABASE: 'coordinator', COORDINATOR_MARIADB_HOST: 'db.internal',
            COORDINATOR_MARIADB_PASSWORD: 'pw', COORDINATOR_MARIADB_USER: 'coordinator'
        };

        assert.deepEqual(loadConfig(env(mariadb)).database,
            { database: 'coordinator', host: 'db.internal', password: 'pw', port: 3306, user: 'coordinator' });
        assert.equal(loadConfig(env({ ...mariadb, COORDINATOR_MARIADB_PORT: '3307' })).database?.port, 3307);
        assert.throws(() => loadConfig(env({ ...mariadb, COORDINATOR_MARIADB_PASSWORD: '' })), /COORDINATOR_MARIADB_PASSWORD must be set/u);
        assert.throws(() => loadConfig(env({ ...mariadb, COORDINATOR_MARIADB_DATABASE: undefined })), /COORDINATOR_MARIADB_DATABASE must be set/u);
    });

    it('read no HIS unless its host is set, and refuse a half-set one (ADR 0019)', () => {
        const his = {
            COORDINATOR_HIS_DATABASE: 'Mydata', COORDINATOR_HIS_HOST: 'his.internal',
            COORDINATOR_HIS_PASSWORD: 'pw', COORDINATOR_HIS_USER: 'telemed_ro'
        };

        assert.equal(loadConfig(env()).his, undefined);
        assert.deepEqual(loadConfig(env(his)).his,
            { database: 'Mydata', host: 'his.internal', password: 'pw', port: 3306, user: 'telemed_ro' });
        assert.equal(loadConfig(env({ ...his, COORDINATOR_HIS_PORT: '3307' })).his?.port, 3307);
        assert.throws(() => loadConfig(env({ ...his, COORDINATOR_HIS_USER: '' })), /COORDINATOR_HIS_USER must be set/u);
    });

    it('have no video player without its URL, and refuse a half-set one', () => {
        assert.equal(loadConfig(env()).videoPlayer, undefined);
        assert.throws(() => loadConfig(env({ COORDINATOR_VIDEO_PLAYER_URL: 'http://vp:8091' })), /COORDINATOR_VIDEO_BASE_URL must be set/u);
    });
});
