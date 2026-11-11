import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { loadConfig, loadWorkers } from '../src/config.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import { RecorderBotUnavailableError } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';
import { VideoPlayerUnavailableError } from '../src/videoPlayer.ts';
import {
    type IRecorderBotWorker,
    type IVideoPlayerWorker,
    MAX_REMEMBERED,
    RecorderBotPool,
    VideoPlayerPool
} from '../src/workers.ts';

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
            { id: 'done', name: 'D' }
        ] } ],
        stations: []
    } ],
    videos: [ { file: 'videos/intro.mp4', id: 'intro', title: 'Intro' } ]
};

/** What a fake worker does: it records what it was given and answers as it is told to. */
interface IFake {
    capacity: number;

    /** How the worker misbehaves: it is `full` (503), `silent` (no answer) or fine. */
    mode: 'full' | 'ok' | 'silent';
    running: string[];
}

/**
 * Makes a fake recorder bot.
 *
 * @param {string} id - The worker's id.
 * @param {number} capacity - How many consultations it may record.
 * @returns {Object} The fake's state and the worker.
 */
function fakeRecorder(id: string, capacity: number): { state: IFake; worker: IRecorderBotWorker; } {
    const state: IFake = { capacity, mode: 'ok', running: [] };

    return {
        state,
        worker: {
            id,
            recordRoom: async (_hn, consultationId) => {
                if (state.mode !== 'ok' || state.running.length >= state.capacity) {
                    throw new RecorderBotUnavailableError(state.mode === 'silent' ? 'unreachable' : 'at_capacity');
                }
                state.running.push(consultationId);

                return consultationId;
            },
            room: async () => {
                if (state.mode === 'silent') {
                    throw new RecorderBotUnavailableError('unreachable');
                }

                return state.capacity - state.running.length;
            }
        }
    };
}

/**
 * Makes a fake video player.
 *
 * @param {string} id - The worker's id.
 * @param {number} capacity - How many videos it may play.
 * @returns {Object} The fake's state and the worker.
 */
function fakeVideoPlayer(id: string, capacity: number): { state: IFake; worker: IVideoPlayerWorker; } {
    const state: IFake = { capacity, mode: 'ok', running: [] };

    return {
        state,
        worker: {
            id,
            play: async ({ room }) => {
                if (state.mode !== 'ok' || state.running.length >= state.capacity) {
                    throw new VideoPlayerUnavailableError(state.mode === 'silent' ? 'unreachable' : 'at_capacity');
                }
                state.running.push(room);
            },
            playingRooms: async () => {
                if (state.mode === 'silent') {
                    throw new VideoPlayerUnavailableError('unreachable');
                }

                return state.running;
            },
            room: async () => {
                if (state.mode === 'silent') {
                    throw new VideoPlayerUnavailableError('unreachable');
                }

                return state.capacity - state.running.length;
            },
            stop: async room => {
                state.running = state.running.filter(r => r !== room);
            }
        }
    };
}

describe('the coordinator service hands consultations and waiting videos to a list of workers', () => {
    let base: string;
    let bots: ReturnType<typeof fakeRecorder>[];
    let players: ReturnType<typeof fakeVideoPlayer>[];
    let recorderPool: RecorderBotPool;
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        bots = [ fakeRecorder('bot-1', 2), fakeRecorder('bot-2', 2) ];
        players = [ fakeVideoPlayer('vp-1', 2), fakeVideoPlayer('vp-2', 2) ];
        recorderPool = new RecorderBotPool(bots.map(b => b.worker));
        store = new Store(mkdtempSync(join(tmpdir(), 'workers-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout,
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: recorderPool,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: { videoPlayer: parseRoleMarker('user.hospital_role=video_player', 'X') },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' },
            videoBaseUrl: 'https://meet.example/',
            videoPlayer: new VideoPlayerPool(players.map(p => p.worker))
        });
        server = createApi({ secret: SECRET, service });

        return new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    });

    afterEach(() => {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    });

    /**
     * Calls the API with the shared secret.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {unknown} [body] - The JSON body.
     * @returns {Promise<Object>} The status and the JSON answer.
     */
    async function call(method: string, path: string, body?: unknown): Promise<{ body: any; status: number; }> {
        const response = await fetch(`${base}${path}`, {
            body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
            headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
            method
        });

        return { body: await response.json(), status: response.status };
    }

    const workerOfConsultation = async (encounterId: string) =>
        (await call('GET', `/encounters/${encounterId}/consultations`)).body.consultations[0].recorderBot;

    it('spreads consultations over two recorder bots', async () => {
        const ids = [];

        for (const hn of [ 'HN/1', 'HN/2', 'HN/3', 'HN/4' ]) {
            ids.push((await call('POST', '/encounters', { hn })).body.id);
        }

        assert.deepEqual(bots.map(b => b.state.running.length), [ 2, 2 ]);
        assert.deepEqual(await Promise.all(ids.map(workerOfConsultation)), [ 'bot-1', 'bot-2', 'bot-1', 'bot-2' ]);
    });

    it('gives a consultation to the recorder bot with the most room', async () => {
        bots[0].state.capacity = 5;
        bots[0].state.running = [ 'a', 'b' ];
        bots[1].state.capacity = 5;
        bots[1].state.running = [ 'c' ];

        const { body: { id } } = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal(await workerOfConsultation(id), 'bot-2');
    });

    it('skips a full or silent recorder bot, and the request goes to the next', async () => {
        bots[0].state.mode = 'silent';

        const first = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal(first.status, 201);
        assert.equal(await workerOfConsultation(first.body.id), 'bot-2');

        // A worker that has room when asked, but answers that it is full, is skipped as well.
        bots[0].state.mode = 'full';
        bots[1].worker.room = async () => 5;

        const second = await call('POST', '/encounters', { hn: 'HN/2' });

        assert.equal(await workerOfConsultation(second.body.id), 'bot-2');
        assert.equal(bots[0].state.running.length, 0);
    });

    it('refuses a consultation as at capacity only when no recorder bot has room', async () => {
        for (const hn of [ 'HN/1', 'HN/2', 'HN/3' ]) {
            assert.equal((await call('POST', '/encounters', { hn })).status, 201);
        }
        bots[0].state.mode = 'silent';
        assert.equal((await call('POST', '/encounters', { hn: 'HN/4' })).status, 201);

        const refused = await call('POST', '/encounters', { hn: 'HN/5' });

        assert.equal(refused.status, 503);
        assert.match(refused.body.error, /at_capacity|unreachable/u);
        assert.equal(service.state.encounters.length, 4);
    });

    it('says at_capacity, and not unreachable, when every recorder bot answers and is full', async () => {
        for (const hn of [ 'HN/1', 'HN/2', 'HN/3', 'HN/4' ]) {
            await call('POST', '/encounters', { hn });
        }

        assert.match((await call('POST', '/encounters', { hn: 'HN/5' })).body.error, /at_capacity/u);
    });

    it('remembers only the latest consultations, so that the memory of the recorder bots does not grow without end', async () => {
        const worker: IRecorderBotWorker = { id: 'bot-x', recordRoom: async (_hn, id) => id, room: async () => 1 };
        const pool = new RecorderBotPool([ worker ]);

        for (let i = 0; i < MAX_REMEMBERED + 50; i++) {
            await pool.recordRoom('HN/1', `c${i}`);
        }

        assert.equal(pool.workerOf('c0'), undefined);
        assert.equal(pool.workerOf(`c${MAX_REMEMBERED + 49}`), 'bot-x');
    });

    it('remembers which recorder bot records each consultation', async () => {
        const { body: { id } } = await call('POST', '/encounters', { hn: 'HN/1' });
        const [ consultation ] = (await call('GET', `/encounters/${id}/consultations`)).body.consultations;

        assert.equal(recorderPool.workerOf(consultation.id), 'bot-1');
        assert.equal(consultation.recorderBot, 'bot-1');
    });

    it('spreads waiting videos over two video players, and stops each on the one that plays it', async () => {
        const ids = [];

        for (const hn of [ 'HN/1', 'HN/2' ]) {
            const { body: { id } } = await call('POST', '/encounters', { hn });

            assert.equal((await call('POST', `/encounters/${id}/video`)).status, 200);
            ids.push(id);
        }

        assert.deepEqual(players.map(p => p.state.running), [ [ 'HN/1' ], [ 'HN/2' ] ]);

        assert.equal((await call('POST', `/encounters/${ids[1]}/video/stop`)).status, 200);
        assert.deepEqual(players.map(p => p.state.running), [ [ 'HN/1' ], [] ]);
    });

    it('skips a full or silent video player, and refuses a video only when none has room', async () => {
        players[0].state.mode = 'silent';

        const a = await call('POST', '/encounters', { hn: 'HN/1' });
        const b = await call('POST', '/encounters', { hn: 'HN/2' });
        const c = await call('POST', '/encounters', { hn: 'HN/3' });

        assert.equal((await call('POST', `/encounters/${a.body.id}/video`)).status, 200);
        assert.equal((await call('POST', `/encounters/${b.body.id}/video`)).status, 200);
        assert.deepEqual(players[1].state.running, [ 'HN/1', 'HN/2' ]);

        const refused = await call('POST', `/encounters/${c.body.id}/video`);

        assert.equal(refused.status, 503);
        assert.equal(players[0].state.running.length, 0);
    });

    it('stops a video on the video player that plays it', async () => {
        const { body: { id } } = await call('POST', '/encounters', { hn: 'HN/1' });

        await call('POST', `/encounters/${id}/video`);
        assert.deepEqual(players[0].state.running, [ 'HN/1' ]);
        assert.equal((await call('POST', `/encounters/${id}/video/stop`)).status, 200);
        assert.deepEqual(players[0].state.running, []);
    });
});

describe('the pools', () => {
    it('learn again which video player plays where from their health reports, and keep a silent one\'s rooms', async () => {
        const players = [ fakeVideoPlayer('vp-1', 2), fakeVideoPlayer('vp-2', 2) ];

        players[0].state.running = [ 'HN/1' ];
        players[1].state.running = [ 'HN/2' ];

        const pool = new VideoPlayerPool(players.map(p => p.worker));

        assert.deepEqual((await pool.playingRooms()).sort(), [ 'HN/1', 'HN/2' ]);
        assert.equal(pool.workerOf('HN/2'), 'vp-2');

        players[1].state.mode = 'silent';
        assert.deepEqual((await pool.playingRooms()).sort(), [ 'HN/1', 'HN/2' ]);

        players[0].state.running = [];
        assert.deepEqual(await pool.playingRooms(), [ 'HN/2' ]);
    });

    it('wait, just after the coordinator service starts, for the first heartbeat to tell of a worker', async () => {
        const bot = fakeRecorder('rb-1', 2);
        let known: IRecorderBotWorker[] = [];
        const pool = new RecorderBotPool(() => known, { waitForWorkersUntil: Date.now() + 2_000 });

        setTimeout(() => {
            known = [ bot.worker ];
        }, 300);

        assert.equal(await pool.recordRoom('HN1', 'c1'), 'c1');
        assert.equal(pool.workerOf('c1'), 'rb-1');
    });

    it('say unreachable, and not at capacity, when no worker is known', async () => {
        await assert.rejects(new RecorderBotPool(() => [], { waitForWorkersUntil: Date.now() - 1 }).recordRoom('HN1', 'c1'),
            { code: 'unreachable' });
        await assert.rejects(new VideoPlayerPool(() => []).play({ room: 'r', token: 't', videoUrl: 'u' }),
            { code: 'unreachable' });
    });

    it('do not skip a worker over a video that is already playing in the room', async () => {
        const player = fakeVideoPlayer('vp-1', 2);

        player.worker.play = async () => {
            throw new VideoPlayerUnavailableError('already_playing');
        };

        await assert.rejects(new VideoPlayerPool([ player.worker, fakeVideoPlayer('vp-2', 2).worker ])
            .play({ room: 'r', token: 't', videoUrl: 'u' }), { code: 'already_playing' });
    });
});

describe('the fixed list of workers in the settings', () => {
    /**
     * Writes a workers file.
     *
     * @param {unknown} content - Its JSON.
     * @returns {string} Its path.
     */
    function workersFile(content: unknown): string {
        const file = join(mkdtempSync(join(tmpdir(), 'workers-file-')), 'workers.json');

        writeFileSync(file, JSON.stringify(content));

        return file;
    }

    const worker = (id: string) => ({ id, secret: `${id}-secret`, url: `http://${id}:8090/` });

    it('reads the recorder bots and the video players', () => {
        const file = workersFile({ recorderBots: [ worker('a'), worker('b') ], videoPlayers: [ worker('c') ] });

        assert.deepEqual(loadWorkers(file), {
            recorderBots: [
                { id: 'a', secret: 'a-secret', url: 'http://a:8090' }, { id: 'b', secret: 'b-secret', url: 'http://b:8090' }
            ],
            videoPlayers: [ { id: 'c', secret: 'c-secret', url: 'http://c:8090' } ]
        });
    });

    it('refuses a malformed list, a worker without a secret and two workers with one id', () => {
        assert.throws(() => loadWorkers(workersFile({ recorderBots: [] })), /at least one worker/u);
        assert.throws(() => loadWorkers(workersFile({ recorderBots: [ { id: 'a', url: 'http://a' } ] })), /"secret"/u);
        assert.throws(() => loadWorkers(workersFile({ recorderBots: [ worker('a') ], videoPlayers: [ worker('a') ] })),
            /two workers are "a"/u);
        assert.throws(() => loadWorkers(join(tmpdir(), 'no-such-workers.json')), /cannot be read/u);
    });

    it('replaces the single recorder bot and video player settings, and one worker of each stays the default', () => {
        const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
            COORDINATOR_API_SECRET: 'secret',
            COORDINATOR_PROSODY_URL: 'http://prosody:5280',
            COORDINATOR_SIGNING_KEY_FILE: workersFile({}),
            COORDINATOR_SIGNING_KID: 'kid',
            COORDINATOR_TOKEN_SUBJECT: 'meet.example',
            ...extra
        });
        const single = loadConfig(env({
            COORDINATOR_RECORDER_BOT_SECRET: 's',
            COORDINATOR_RECORDER_BOT_URL: 'http://bot:8090/'
        }));

        assert.deepEqual(single.recorderBots, [ { id: 'recorder-bot', secret: 's', url: 'http://bot:8090' } ]);

        const several = loadConfig(env({
            COORDINATOR_VIDEO_BASE_URL: 'https://meet.example/',
            COORDINATOR_VIDEO_PLAYER_MARKER: 'user.hospital_role=video_player',
            COORDINATOR_WORKERS_FILE: workersFile({ recorderBots: [ worker('a'), worker('b') ], videoPlayers: [ worker('c') ] })
        }));

        assert.deepEqual(several.recorderBots.map(w => w.id), [ 'a', 'b' ]);
        assert.deepEqual(several.videoPlayer?.workers.map(w => w.id), [ 'c' ]);
    });
});
