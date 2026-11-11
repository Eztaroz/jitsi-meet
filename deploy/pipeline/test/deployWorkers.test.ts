import assert from 'node:assert/strict';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { DeployError, type IWorkerStatus, deployWorkers, workerTag } from '../deployWorkers.ts';

const NEW = 'bbbbbbbb';
const OLD = 'aaaaaaaa';

/** One fake server: the coordinator service, the VMs' webhooks and the registry. */
class Fake {
    workers: IWorkerStatus[] = [];
    events: string[] = [];
    tags = new Map<string, string>();

    /** Workers whose VM does not come up healthy on the new build. */
    brokenOnNew = new Set<string>();

    /** Looks of the list after which a draining worker runs nothing. */
    busyLooks: Record<string, number> = {};

    /**
     * Workers that start a consultation just before they were set draining, which the coordinator service learns only
     * from a heartbeat sent after that. It counts the looks at the list since the worker was set draining.
     */
    lateStart: Record<string, number> = {};
    server!: Server;
    url = '';

    worker(id: string) {
        return this.workers.find(w => w.id === id)!;
    }

    handle = async (req: IncomingMessage, res: ServerResponse) => {
        const path = req.url ?? '';
        const chunks: Buffer[] = [];

        for await (const c of req) {
            chunks.push(c as Buffer);
        }
        const body = Buffer.concat(chunks).toString();
        const json = (status: number, value: unknown) => {
            res.writeHead(status, { 'content-type': 'application/json' });
            res.end(JSON.stringify(value));
        };

        if (path.startsWith('/workers') && req.headers.authorization !== 'Bearer pipeline') {
            return json(401, {});
        }
        if (path === '/workers' && req.method === 'GET') {
            for (const w of this.workers) {
                if (w.draining && w.id in this.lateStart) {
                    const since = ++this.lateStart[w.id];

                    // The first look sees the heartbeat of before: no news. Each look after it is one more heartbeat,
                    // and the third look is the first to say what the worker really runs, until it ends at the sixth.
                    w.heartbeats = (w.heartbeats ?? 0) + (since > 1 ? 1 : 0);
                    w.running = since >= 3 && since < 6 ? 1 : 0;
                }
            }
            for (const w of this.workers) {
                if (w.draining && (this.busyLooks[w.id] ?? 0) > 0 && --this.busyLooks[w.id] === 0) {
                    w.running = 0;
                }
            }

            return json(200, { workers: this.workers });
        }

        const drain = /^\/workers\/([^/]+)\/draining$/u.exec(path);

        if (drain && req.method === 'PUT') {
            const { draining } = JSON.parse(body);

            this.worker(drain[1]).draining = draining;
            this.events.push(`${draining ? 'drain' : 'undrain'} ${drain[1]}`);

            return json(200, {});
        }

        const hook = /^\/hook\/([^/]+)$/u.exec(path);

        if (hook) {
            const id = hook[1];

            if (id in this.lateStart && this.lateStart[id] < 6) {
                this.events.push(`CUT ${id}`);
            }
            const tag = this.tags.get(workerTag(id))!;

            this.events.push(`webhook ${id}`);

            // The VM pulls the tag it follows, and its worker reports that build, unless that build is broken.
            if (!(tag === NEW && this.brokenOnNew.has(id))) {
                this.worker(id).build = tag;
            }

            return json(200, {});
        }

        const manifest = /^\/v2\/(.+)\/manifests\/([^/]+)$/u.exec(path);

        if (manifest) {
            const [ , , tag ] = manifest;

            if (req.method === 'PUT') {
                const { image } = JSON.parse(body);

                this.tags.set(tag, image);
                this.events.push(`tag ${tag}=${image}`);

                return json(201, {});
            }
            if (tag === NEW || tag === OLD) {
                res.writeHead(200, { 'content-type': 'application/vnd.oci.image.manifest.v1+json' });
                res.end(req.method === 'HEAD' ? undefined : JSON.stringify({ image: tag }));

                return;
            }

            return json(404, {});
        }
        json(404, {});
    };

    async start() {
        this.server = createServer((req, res) => {
            this.handle(req, res).catch(() => {
                res.writeHead(500);
                res.end();
            });
        });
        await new Promise<void>(resolve => this.server.listen(0, '127.0.0.1', resolve));
        this.url = `http://127.0.0.1:${(this.server.address() as AddressInfo).port}`;
    }
}

const make = (id: string, kind: IWorkerStatus['kind'], extra: Partial<IWorkerStatus> = {}): IWorkerStatus =>
    ({ build: OLD, capacity: 4, draining: false, id, kind, lost: false, running: 0, url: 'http://x', ...extra });

describe('deployWorkers', () => {
    let fake: Fake;
    const run = (extra: Record<string, unknown> = {}) => deployWorkers({
        build: NEW,
        coordinatorUrl: fake.url,
        healthTimeoutMs: 300,
        images: { 'recorder-bot': 'g/p/recorder-bot', 'video-player': 'g/p/video-player' },
        pipelineSecret: 'pipeline',
        pollMs: 20,
        registry: { auth: 'x', baseUrl: fake.url },
        webhook: id => `${fake.url}/hook/${id}`,
        ...extra
    });

    beforeEach(async () => {
        fake = new Fake();
        await fake.start();
    });
    afterEach(() => {
        fake.server.close();
    });

    it('deploys the workers one at a time, each drained first and taking work again after', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot', { running: 2 }), make('bot-2', 'recorder-bot'),
            make('player-1', 'video-player') ];
        fake.busyLooks['bot-1'] = 3;

        const result = await run();

        assert.deepEqual(result, { deployed: [ 'bot-1', 'bot-2', 'player-1' ], skipped: [] });
        assert.deepEqual(fake.events, [
            'drain bot-1', 'tag production-bot-1=bbbbbbbb', 'webhook bot-1', 'undrain bot-1',
            'drain bot-2', 'tag production-bot-2=bbbbbbbb', 'webhook bot-2', 'undrain bot-2',
            'drain player-1', 'tag production-player-1=bbbbbbbb', 'webhook player-1', 'undrain player-1',
            'tag production=bbbbbbbb', 'tag production=bbbbbbbb'
        ]);
        assert.ok(fake.workers.every(w => w.build === NEW && !w.draining));
    });

    it('waits for a worker to run nothing before it calls the webhook', async () => {
        fake.workers = [ make('player-1', 'video-player', { running: 2 }) ];
        fake.busyLooks['player-1'] = 3;

        await run();

        assert.equal(fake.worker('player-1').running, 0);
        assert.ok(fake.events.indexOf('webhook player-1') > fake.events.indexOf('drain player-1'));
    });

    it('does not trust a heartbeat from before the worker was set draining: it waits for later ones', async () => {
        fake.workers = [ make('player-1', 'video-player', { heartbeats: 10, running: 0 }) ];
        fake.lateStart['player-1'] = 0;

        await run();

        assert.ok(!fake.events.includes('CUT player-1'), 'the consultation that started just before was not cut');
        assert.ok(fake.events.includes('webhook player-1'));
    });

    it('does not deploy to a worker that already runs the build', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot', { build: NEW }), make('bot-2', 'recorder-bot') ];

        const result = await run();

        assert.deepEqual(result.deployed, [ 'bot-2' ]);
    });

    it('rolls a worker back when it is not healthy in time, and stops before the next', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot'), make('bot-2', 'recorder-bot') ];
        fake.brokenOnNew.add('bot-1');

        await assert.rejects(run(),
            (error: Error) => error instanceof DeployError && /rolled back to aaaaaaaa/u.test(error.message));
        assert.deepEqual(fake.events, [
            'drain bot-1', 'tag production-bot-1=bbbbbbbb', 'webhook bot-1',
            'tag production-bot-1=aaaaaaaa', 'webhook bot-1', 'undrain bot-1'
        ]);
        assert.equal(fake.worker('bot-1').build, OLD);
        assert.equal(fake.worker('bot-2').build, OLD);
        assert.equal(fake.tags.has('production'), false);
    });

    it('does not count a worker healthy when its own health check fails', async () => {
        fake.workers = [ make('player-1', 'video-player') ];

        await assert.rejects(run({ healthCheck: () => ({ url: `${fake.url}/nope` }) }), DeployError);
        assert.ok(fake.events.includes('tag production-player-1=aaaaaaaa'));
    });

    it('leaves a lone recorder bot for the night window, and deploys the video player', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot'), make('player-1', 'video-player') ];

        const result = await run();

        assert.deepEqual(result, { deployed: [ 'player-1' ], skipped: [ 'bot-1' ] });
        assert.equal(fake.worker('bot-1').build, OLD);
        assert.ok(!fake.events.includes('drain bot-1'));
        assert.deepEqual(fake.events.filter(e => e.startsWith('tag production=')), [ 'tag production=bbbbbbbb' ]);
    });

    it('deploys a lone recorder bot in the night window', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot') ];

        const result = await run({ allowSingleRecorderBot: true });

        assert.deepEqual(result.deployed, [ 'bot-1' ]);
    });

    it('does not take a recorder bot down while the other one is lost', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot', { lost: true }), make('bot-2', 'recorder-bot') ];

        const result = await run();

        assert.deepEqual(result, { deployed: [], skipped: [ 'bot-1', 'bot-2' ] });
    });

    it('refuses to start when a worker is already draining', async () => {
        fake.workers = [ make('bot-1', 'recorder-bot', { draining: true }), make('bot-2', 'recorder-bot') ];

        await assert.rejects(run(), /already draining/u);
        assert.deepEqual(fake.events, []);
    });

    it('sets the worker taking work again and stops when it does not drain', async () => {
        fake.workers = [ make('player-1', 'video-player', { running: 1 }) ];
        fake.busyLooks['player-1'] = 1000;

        await assert.rejects(run({ drainTimeoutMs: 100 }), /still runs 1/u);
        assert.deepEqual(fake.events, [ 'drain player-1', 'undrain player-1' ]);
    });
});
