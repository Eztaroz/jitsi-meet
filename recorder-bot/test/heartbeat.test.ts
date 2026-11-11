import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, beforeEach, describe, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';

import { loadConfig } from '../src/config.ts';
import { HEARTBEAT_MS, Heartbeat } from '../src/heartbeat.ts';

/** A coordinator service that keeps the heartbeats it gets and answers with a status. */
describe('the heartbeat to the coordinator service', () => {
    const received: { authorization?: string; body: Record<string, unknown>; path?: string; }[] = [];
    let answer = 200;
    let answerBody = '{}';
    let running = 1;
    let server: Server;
    let url = '';

    before(async () => {
        server = createServer((req, res) => {
            const chunks: Buffer[] = [];

            req.on('data', c => chunks.push(c));
            req.on('end', () => {
                received.push({
                    authorization: req.headers.authorization,
                    body: JSON.parse(Buffer.concat(chunks).toString()),
                    path: req.url
                });
                res.writeHead(answer, { 'content-type': 'application/json' });
                res.end(answerBody);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/coordinator/`;
    });
    after(() => {
        server.close();
        server.closeAllConnections();
    });
    beforeEach(() => {
        received.length = 0;
        answer = 200;
        answerBody = '{}';
        running = 1;
    });

    const make = (coordinatorUrl = url, intervalMs?: number) => new Heartbeat({
        advertisedUrl: 'http://worker-1:8090', build: 'abc123', coordinatorUrl, id: 'worker-1', intervalMs,
        secret: 'worker-1-secret', status: () => ({ capacity: 3, running })
    });

    test('is 5 seconds apart', () => {
        assert.equal(HEARTBEAT_MS, 5_000);
    });

    test('says who the worker is, what it runs and what build, with its own secret', async () => {
        assert.equal(await make().send(), true);
        assert.deepEqual(received, [ {
            authorization: 'Bearer worker-1-secret',
            body: { build: 'abc123', capacity: 3, id: 'worker-1', kind: 'recorder-bot', running: 1, url: 'http://worker-1:8090' },
            path: '/coordinator/workers/heartbeat'
        } ]);
    });

    test('reports how many it runs now', async () => {
        const heartbeat = make();

        await heartbeat.send();
        running = 2;
        await heartbeat.send();
        assert.deepEqual(received.map(r => r.body.running), [ 1, 2 ]);
    });

    test('is sent at once and then at every interval, until stopped', async () => {
        const heartbeat = make(url, 20);

        heartbeat.start();
        for (let i = 0; i < 100 && received.length < 3; i++) {
            await sleep(20);
        }
        heartbeat.stop();
        assert.ok(received.length >= 3, `got ${received.length}`);

        // A heartbeat on its way when stopped still arrives; no other does.
        await sleep(60);

        const count = received.length;

        await sleep(60);
        assert.equal(received.length, count);
    });

    test('stops the consultations the coordinator service says were taken over (ADR 0016)', async () => {
        const taken: string[][] = [];
        const heartbeat = new Heartbeat({
            advertisedUrl: 'http://worker-1:8090', build: 'abc123', coordinatorUrl: url, id: 'worker-1',
            onTakenOver: ids => taken.push(ids), secret: 'worker-1-secret', status: () => ({ capacity: 3, running })
        });

        await heartbeat.send();
        answerBody = JSON.stringify({ status: 'ok', takenOver: [ 'c1', 'c2' ] });
        await heartbeat.send();
        answerBody = 'not json';
        assert.equal(await heartbeat.send(), true);
        assert.deepEqual(taken, [ [ 'c1', 'c2' ] ]);
    });

    test('does not throw when refused or when the coordinator service cannot be reached', async () => {
        answer = 401;
        assert.equal(await make().send(), false);
        assert.equal(await make('http://127.0.0.1:1').send(), false);
    });

    test('is set up from the environment', () => {
        const env = {
            RECORDER_BOT_ADVERTISED_URL: 'http://worker-1:8090/',
            RECORDER_BOT_BUILD: 'abc123',
            RECORDER_BOT_HEARTBEAT_URL: 'https://meet.example/coordinator/',
            RECORDER_BOT_ID: 'worker-1',
            RECORDER_BOT_API_SECRET: 'api-secret',
            RECORDER_BOT_JID: 'bot@recorder.example',
            RECORDER_BOT_JITSI_URL: 'https://meet.example',
            RECORDER_BOT_PASSWORD: 'pw',
            RECORDER_BOT_SPOOL_DIR: '/spool',
            RECORDER_BOT_STORAGE_ROOT: '/evidence'
        };
        const { heartbeat } = loadConfig(env);

        assert.deepEqual(heartbeat, {
            advertisedUrl: 'http://worker-1:8090', build: 'abc123', coordinatorUrl: 'https://meet.example/coordinator',
            id: 'worker-1'
        });
        assert.equal(loadConfig({ ...env, RECORDER_BOT_HEARTBEAT_URL: '' }).heartbeat, undefined);
        assert.throws(() => loadConfig({ ...env, RECORDER_BOT_ID: '' }), /RECORDER_BOT_ID must be set/u);
        assert.throws(() => loadConfig({ ...env, RECORDER_BOT_ADVERTISED_URL: '' }), /RECORDER_BOT_ADVERTISED_URL must be set/u);
    });
});
