import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { loadWorkerSecrets } from '../src/config.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';
import { LOST_AFTER_MS, WorkerRegistry } from '../src/workerRegistry.ts';
import { RecorderBotPool, VideoPlayerPool } from '../src/workers.ts';

const SECRET = 'system-secret';
const PIPELINE = 'pipeline-secret';
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

/** A fake worker: a small server with the control API of a recorder bot or of a video player. */
interface IFakeWorker {
    capacity: number;
    close: () => void;
    id: string;
    kind: 'recorder-bot' | 'video-player';
    running: string[];
    secret: string;
    url: string;
}

/**
 * Starts a fake worker.
 *
 * @param {string} id - Its id.
 * @param {'recorder-bot'|'video-player'} kind - Its kind.
 * @param {number} capacity - How many it can run.
 * @returns {Promise<IFakeWorker>}
 */
function fakeWorker(id: string, kind: IFakeWorker['kind'], capacity: number): Promise<IFakeWorker> {
    const worker = { capacity, id, kind, running: [] as string[], secret: `${id}-secret` } as IFakeWorker;
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];

        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const reply = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            if (req.headers.authorization !== `Bearer ${worker.secret}`) {
                return reply(401, {});
            }

            const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};

            if (req.url === '/health') {
                return reply(200, kind === 'recorder-bot'
                    ? { activeConsultations: worker.running.length, maxConsultations: capacity, status: 'ok' }
                    : { activeRooms: worker.running.length, maxRooms: capacity, rooms: worker.running, status: 'ok' });
            }
            if (req.url === '/consultations') {
                worker.running.push(body.consultationId);

                return reply(201, { consultationId: body.consultationId });
            }
            if (req.url === '/play') {
                worker.running.push(body.room);

                return reply(201, { room: body.room, status: 'playing' });
            }
            if (req.url === '/stop') {
                worker.running = worker.running.filter(r => r !== body.room);

                return reply(200, { room: body.room, status: 'stopped' });
            }

            return reply(404, {});
        });
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            worker.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            worker.close = () => {
                server.close();
                server.closeAllConnections();
            };
            resolve(worker);
        });
    });
}

describe('workers send heartbeats to the coordinator service', () => {
    let base: string;
    let clock: number;
    let dir: string;
    let secretsFile: string;
    let server: Server;
    let service: CoordinatorService;
    let store: Store;
    let workers: IFakeWorker[];

    /**
     * Writes the list of workers and their secrets.
     *
     * @param {IFakeWorker[]} listed - The workers on the list.
     * @returns {void}
     */
    function list(listed: IFakeWorker[]): void {
        const of = (kind: string) => listed.filter(w => w.kind === kind).map(w => ({ id: w.id, secret: w.secret }));

        writeFileSync(secretsFile, JSON.stringify({ recorderBots: of('recorder-bot'), videoPlayers: of('video-player') }));
    }

    /**
     * Starts a coordinator service as the process does: nothing is known of the workers but the list.
     *
     * @returns {Promise<void>}
     */
    function boot(): Promise<void> {
        store = new Store(dir);

        const registry = new WorkerRegistry({ file: secretsFile, now: () => clock });

        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout,
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: new RecorderBotPool(() => registry.recorderBots()),
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: { videoPlayer: parseRoleMarker('user.hospital_role=video_player', 'X') },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' },
            videoBaseUrl: 'https://meet.example/',
            videoPlayer: new VideoPlayerPool(() => registry.videoPlayers())
        });
        server = createApi({ pipelineSecret: PIPELINE, secret: SECRET, service, workers: registry });

        return new Promise<void>(resolve => {
            server.listen(0, '127.0.0.1', () => {
                base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
                resolve();
            });
        });
    }

    /**
     * Stops the coordinator service.
     *
     * @returns {void}
     */
    function shutDown(): void {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    }

    beforeEach(async () => {
        clock = 1_000_000;
        dir = mkdtempSync(join(tmpdir(), 'heartbeat-'));
        secretsFile = join(dir, 'workers.json');
        workers = [
            await fakeWorker('bot-1', 'recorder-bot', 2),
            await fakeWorker('bot-2', 'recorder-bot', 5),
            await fakeWorker('vp-1', 'video-player', 2)
        ];
        list([ workers[0], workers[2] ]);
        await boot();
    });

    afterEach(() => {
        shutDown();
        workers.forEach(w => w.close());
    });

    /**
     * Calls the API.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {Object} [options] - The bearer secret and the JSON body.
     * @returns {Promise<Object>} The status and the JSON answer.
     */
    async function call(method: string, path: string, options: { body?: unknown; secret?: string; } = {}) {
        const response = await fetch(`${base}${path}`, {
            body: method === 'GET' ? undefined : JSON.stringify(options.body ?? {}),
            headers: { authorization: `Bearer ${options.secret ?? SECRET}`, 'content-type': 'application/json' },
            method
        });

        return { body: await response.json() as any, status: response.status };
    }

    /**
     * Sends a heartbeat as a worker does.
     *
     * @param {IFakeWorker} worker - The worker.
     * @param {Object} [overrides] - What differs from a good heartbeat.
     * @param {string} [secret] - The secret to send; the worker's by default.
     * @returns {Promise<Object>}
     */
    function heartbeat(worker: IFakeWorker, overrides: object = {}, secret = worker.secret) {
        return call('POST', '/workers/heartbeat', {
            body: {
                build: 'build-7', capacity: worker.capacity, id: worker.id, kind: worker.kind,
                running: worker.running.length, url: worker.url, ...overrides
            },
            secret
        });
    }

    const encounter = async (hn: string) => (await call('POST', '/encounters', { body: { hn } })).body;
    const recordedBy = async (id: string) =>
        (await call('GET', `/encounters/${id}/consultations`)).body.consultations[0].recorderBot;

    it('refuses a heartbeat with a wrong secret, or from a worker that is not on the list', async () => {
        assert.equal((await heartbeat(workers[0], {}, 'wrong')).status, 401);
        assert.equal((await heartbeat(workers[0], {}, SECRET)).status, 401);
        assert.equal((await heartbeat(workers[0], {}, workers[2].secret)).status, 401);
        assert.equal((await heartbeat(workers[1])).status, 401);
        assert.deepEqual((await call('GET', '/workers')).body.workers, []);
    });

    it('refuses a heartbeat that is malformed, or of another kind than the list says', async () => {
        assert.equal((await heartbeat(workers[0], { kind: 'video-player' })).status, 400);
        assert.equal((await heartbeat(workers[0], { capacity: -1 })).status, 400);
        assert.equal((await heartbeat(workers[0], { url: 'not a url' })).status, 400);
        assert.equal((await heartbeat(workers[0], { build: '' })).status, 400);
    });

    it('hands work to the workers heard from, and to none before', async () => {
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/0' } })).status, 503);

        assert.equal((await heartbeat(workers[0])).status, 200);

        const { id } = await encounter('HN/1');

        assert.equal(await recordedBy(id), 'bot-1');
    });

    it('brings a worker added to the list into service, and shuts it out at once when its line goes', async () => {
        await heartbeat(workers[0]);
        assert.equal((await heartbeat(workers[1])).status, 401);

        list(workers);
        assert.equal((await heartbeat(workers[1])).status, 200);
        assert.equal(await recordedBy((await encounter('HN/1')).id), 'bot-2');

        list([ workers[0] ]);
        assert.equal(await recordedBy((await encounter('HN/2')).id), 'bot-1');
        assert.equal((await heartbeat(workers[1])).status, 401);
        assert.deepEqual((await call('GET', '/workers')).body.workers.map((w: { id: string; }) => w.id), [ 'bot-1' ]);
    });

    it('gives no new work to a worker silent for 15 seconds, and lists it as lost', async () => {
        await heartbeat(workers[0]);
        clock += LOST_AFTER_MS - 1;
        assert.equal((await call('GET', '/workers')).body.workers[0].lost, false);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/1' } })).status, 201);

        clock += 1;
        assert.equal((await call('GET', '/workers')).body.workers[0].lost, true);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/2' } })).status, 503);

        await heartbeat(workers[0]);
        assert.equal((await call('GET', '/workers')).body.workers[0].lost, false);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/3' } })).status, 201);
    });

    it('lists the workers with their kind, build, capacity, running count and whether they are lost', async () => {
        workers[2].running = [ 'HN/9' ];
        await heartbeat(workers[0], { build: 'abc123', running: 1 });
        await heartbeat(workers[2]);
        clock += LOST_AFTER_MS;
        await heartbeat(workers[2]);

        const { body, status } = await call('GET', '/workers');

        assert.equal(status, 200);
        assert.deepEqual(body.workers, [
            { build: 'abc123', capacity: 2, id: 'bot-1', kind: 'recorder-bot', draining: false, lost: true, running: 1, url: workers[0].url },
            { build: 'build-7', capacity: 2, id: 'vp-1', kind: 'video-player', draining: false, lost: false, running: 1, url: workers[2].url }
        ]);
        assert.equal((await call('GET', '/workers', { secret: 'wrong' })).status, 401);
    });

    const drain = (id: string, draining: unknown, secret = PIPELINE) =>
        call('PUT', `/workers/${id}/draining`, { body: { draining }, secret });

    it('lets only the pipeline set a worker draining or clear it', async () => {
        await heartbeat(workers[0]);

        assert.equal((await drain('bot-1', true, SECRET)).status, 403);
        assert.equal((await drain('bot-1', true, workers[0].secret)).status, 401);
        assert.equal((await drain('bot-1', true, 'wrong')).status, 401);
        assert.equal((await call('GET', '/workers')).body.workers[0].draining, false);

        assert.deepEqual((await drain('bot-1', true)).body, { draining: true, id: 'bot-1' });
        assert.equal((await call('GET', '/workers')).body.workers[0].draining, true);
        assert.equal((await drain('bot-1', false, SECRET)).status, 403);
        assert.equal((await call('GET', '/workers')).body.workers[0].draining, true);
        assert.equal((await drain('bot-1', false)).status, 200);
        assert.equal((await call('GET', '/workers')).body.workers[0].draining, false);
    });

    it('refuses to set draining on a worker that is not on the list, or with a body that is not a boolean', async () => {
        assert.equal((await drain('nobody', true)).status, 404);
        assert.equal((await drain('bot-1', 'yes')).status, 400);
        assert.equal((await call('PUT', '/workers/bot-1/draining', { secret: PIPELINE })).status, 400);
    });

    it('lets the pipeline list the workers to wait for their running count', async () => {
        await heartbeat(workers[0]);
        assert.equal((await call('GET', '/workers', { secret: PIPELINE })).body.workers[0].id, 'bot-1');
    });

    it('tells a worker in its heartbeat answer whether it is draining', async () => {
        assert.deepEqual((await heartbeat(workers[0])).body, { draining: false, status: 'ok' });
        await drain('bot-1', true);
        assert.deepEqual((await heartbeat(workers[0])).body, { draining: true, status: 'ok' });
        await drain('bot-1', false);
        assert.equal((await heartbeat(workers[0])).body.draining, false);
    });

    it('hands no new consultation to a draining recorder bot, and no waiting video to a draining video player', async () => {
        list(workers);
        await heartbeat(workers[0]);
        await heartbeat(workers[1]);
        await heartbeat(workers[2]);

        const first = (await encounter('HN/1')).id;

        assert.equal(await recordedBy(first), 'bot-2');
        await drain('bot-2', true);
        await drain('vp-1', true);

        const second = (await encounter('HN/2')).id;

        assert.equal(await recordedBy(second), 'bot-1');
        assert.equal((await call('POST', `/encounters/${second}/video`)).status, 503);
        assert.deepEqual(workers[2].running, []);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/3' } })).status, 201);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/4' } })).status, 503);

        await drain('bot-2', false);
        assert.equal((await call('POST', '/encounters', { body: { hn: 'HN/5' } })).status, 201);
    });

    it('lets a consultation and a video that run on a draining worker end normally', async () => {
        await heartbeat(workers[0]);
        await heartbeat(workers[2]);

        const { id } = await encounter('HN/1');

        assert.equal((await call('POST', `/encounters/${id}/video`)).status, 200);
        await drain('bot-1', true);
        await drain('vp-1', true);

        assert.deepEqual(workers[2].running, [ 'HN/1' ]);
        assert.equal((await call('POST', `/encounters/${id}/video/stop`)).status, 200);
        assert.deepEqual(workers[2].running, []);
    });

    it('can still stop a waiting video after the coordinator service restarts', async () => {
        await heartbeat(workers[0]);
        await heartbeat(workers[2]);

        const { id } = await encounter('HN/1');

        assert.equal((await call('POST', `/encounters/${id}/video`)).status, 200);
        assert.deepEqual(workers[2].running, [ 'HN/1' ]);

        shutDown();
        await boot();

        // Nothing is known of the workers until the first heartbeat, one period later.
        await heartbeat(workers[2]);
        assert.equal((await call('POST', `/encounters/${id}/video/stop`)).status, 200);
        assert.deepEqual(workers[2].running, []);
    });
});

describe('the list of workers and their secrets', () => {
    it('is read from a file, with no address: a worker says where it is in its heartbeat', () => {
        const file = join(mkdtempSync(join(tmpdir(), 'secrets-')), 'workers.json');

        writeFileSync(file, JSON.stringify({ recorderBots: [ { id: 'a', secret: 's' } ] }));
        assert.deepEqual(loadWorkerSecrets(file), { recorderBots: [ { id: 'a', secret: 's' } ], videoPlayers: [] });

        writeFileSync(file, JSON.stringify({ recorderBots: [ { id: 'a', secret: 's' } ], videoPlayers: [ { id: 'a', secret: 't' } ] }));
        assert.throws(() => loadWorkerSecrets(file), /two workers are "a"/u);

        writeFileSync(file, JSON.stringify({ recorderBots: [ { id: 'a' } ] }));
        assert.throws(() => loadWorkerSecrets(file), /"secret"/u);
    });
});
