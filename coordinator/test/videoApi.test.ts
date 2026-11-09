import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';
import type { IVideoPlayer } from '../src/videoPlayer.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const layout: ILayout = {
    centers: [ {
        id: 'c1',
        pathways: [ { id: 'default', stages: [
            { id: 'waiting', name: 'W', defaultVideo: 'intro' },
            { id: 'examination', name: 'E' },
            { id: 'done', name: 'D' }
        ] } ],
        stations: []
    } ],
    videos: [ { file: 'videos/intro.mp4', id: 'intro', title: 'Intro' }, { file: 'videos/b.mp4', id: 'b', title: 'B' } ]
};

describe('the API for waiting videos', () => {
    let base: string;
    let playing: string[] = [];
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    const player: IVideoPlayer = {
        play: async ({ room }) => {
            playing.push(room);
        },
        playingRooms: async () => playing,
        stop: async room => {
            playing = playing.filter(r => r !== room);
        }
    };

    before(() => {
        store = new Store(mkdtempSync(join(tmpdir(), 'video-api-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout,
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: { videoPlayer: parseRoleMarker('user.hospital_role=video_player', 'X') },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' },
            videoBaseUrl: 'https://meet.example/',
            videoPlayer: player
        });
        server = createApi({ secret: SECRET, service });

        return new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    });

    after(() => {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    });

    /**
     * Calls the API with the shared secret.
     *
     * @param {string} path - The path.
     * @param {unknown} [body] - The JSON body.
     * @returns {Promise<Object>} The status and the JSON answer.
     */
    async function post(path: string, body: unknown = {}): Promise<{ body: any; status: number; }> {
        const response = await fetch(`${base}${path}`, {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
            method: 'POST'
        });

        return { body: await response.json(), status: response.status };
    }

    it('plays and stops the video of an encounter, and refuses what cannot be done', async () => {
        const { body: { id } } = await post('/encounters', { hn: 'HN/1' });

        assert.equal((await post('/encounters/nope/video')).status, 404);
        assert.equal((await post(`/encounters/${id}/video/stop`)).status, 409);
        assert.equal((await post(`/encounters/${id}/video`, { video: 'nope' })).status, 400);
        assert.equal((await post(`/encounters/${id}/video`, { video: 7 })).status, 400);

        const started = await post(`/encounters/${id}/video`);

        assert.deepEqual([ started.status, started.body.video ], [ 200, 'intro' ]);
        assert.deepEqual(playing, [ 'HN/1' ]);
        assert.equal((await post(`/encounters/${id}/video`)).status, 409);

        const stopped = await post(`/encounters/${id}/video/stop`);

        assert.equal(stopped.status, 200);
        assert.deepEqual(playing, []);
    });

    it('plays the video asked for instead of the stage\'s default', async () => {
        const { body: { id } } = await post('/encounters', { hn: 'HN/2' });

        await service.changeStage(id, 'examination', 'system');
        assert.equal((await post(`/encounters/${id}/video`)).status, 409);
        assert.equal((await post(`/encounters/${id}/video`, { video: 'b' })).body.video, 'b');
    });
});
