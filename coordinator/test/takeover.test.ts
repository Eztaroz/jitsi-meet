import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

import { createApi } from '../src/api.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';
import { HEARTBEAT_MS, LOST_AFTER_MS, WorkerRegistry } from '../src/workerRegistry.ts';
import { RecorderBotPool } from '../src/workers.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

/** A fake recorder bot: a small server with the control API of the recorder bot service. */
interface IFakeBot {
    asked: Record<string, string>[];
    capacity: number;
    close: () => void;
    id: string;
    running: string[];
    secret: string;
    url: string;
}

/**
 * Starts a fake recorder bot.
 *
 * @param {string} id - Its id.
 * @param {number} capacity - How many consultations it can record.
 * @returns {Promise<IFakeBot>}
 */
function fakeBot(id: string, capacity: number): Promise<IFakeBot> {
    const bot = { asked: [], capacity, id, running: [], secret: `${id}-secret` } as unknown as IFakeBot;
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = [];

        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const reply = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            if (req.headers.authorization !== `Bearer ${bot.secret}`) {
                return reply(401, {});
            }
            if (req.url === '/health') {
                return reply(200, { activeConsultations: bot.running.length, maxConsultations: bot.capacity });
            }

            const body = JSON.parse(Buffer.concat(chunks).toString() || '{}');

            bot.asked.push(body);
            bot.running.push(body.consultationId);

            return reply(201, { consultationId: body.consultationId });
        });
    });

    return new Promise(resolve => {
        server.listen(0, '127.0.0.1', () => {
            bot.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            bot.close = () => {
                server.close();
                server.closeAllConnections();
            };
            resolve(bot);
        });
    });
}

describe('a lost recorder bot\'s consultation is taken over by another (ADR 0016)', () => {
    let base: string;
    let bots: IFakeBot[];
    let clock: number;
    let dir: string;
    let prosodyRooms: { name: string; occupants: unknown[]; }[];
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    /**
     * Starts the service as the process does, over a registry of heartbeats.
     *
     * @returns {Promise<void>}
     */
    function boot(listed: IFakeBot[] = bots): Promise<void> {
        const file = join(dir, 'workers.json');

        writeFileSync(file, JSON.stringify({ recorderBots: listed.map(b => ({ id: b.id, secret: b.secret })) }));
        store = new Store(dir);

        const registry = new WorkerRegistry({ file, now: () => clock });

        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
            lostRecorderBots: claimed => registry.lostRecorderBots(claimed),
            prosody: { rooms: async () => ({ rooms: prosodyRooms }) } as unknown as Prosody,
            recorderBot: new RecorderBotPool(() => registry.recorderBots()),
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
        server = createApi({ secret: SECRET, service, workers: registry });

        return new Promise<void>(resolve => server.listen(0, '127.0.0.1', () => {
            base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
            resolve();
        }));
    }

    /**
     * Calls the API with the system's secret, or a bearer secret given.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {unknown} [body] - The JSON body.
     * @param {string} [secret] - The bearer secret.
     * @returns {Promise<Object>}
     */
    async function call(method: string, path: string, body?: unknown, secret = SECRET) {
        const response = await fetch(`${base}${path}`, {
            body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
            headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
            method
        });

        return { body: await response.json() as any, status: response.status };
    }

    const beat = (bot: IFakeBot) => call('POST', '/workers/heartbeat', {
        build: 'b1', capacity: bot.capacity, consultations: [ ...bot.running ], id: bot.id, kind: 'recorder-bot',
        running: bot.running.length, url: bot.url
    }, bot.secret);
    const consultationOf = async (encounterId: string) =>
        (await call('GET', `/encounters/${encounterId}/consultations`)).body.consultations[0];

    /**
     * Moves both the registry's clock and the service's on.
     *
     * @param {number} ms - How far.
     * @returns {void}
     */
    function pass(ms: number): void {
        clock += ms;
        mock.timers.tick(ms);
    }

    /**
     * Both bots send a heartbeat, an encounter starts on bot-1 (the one with more room), and bot-1 then goes silent
     * for as long as it takes to be lost, while bot-2 keeps sending.
     *
     * @returns {Promise<string>} The encounter's id.
     */
    async function loseBot1(): Promise<string> {
        await beat(bots[0]);
        await beat(bots[1]);

        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-1');
        pass(LOST_AFTER_MS);
        await beat(bots[1]);

        return started.body.id;
    }

    beforeEach(async () => {
        clock = Date.parse('2026-05-01T08:00:00Z');
        mock.timers.enable({ apis: [ 'Date' ], now: clock });
        dir = mkdtempSync(join(tmpdir(), 'takeover-'));
        prosodyRooms = [];
        bots = [ await fakeBot('bot-1', 5), await fakeBot('bot-2', 2) ];
        await boot();
    });

    afterEach(() => {
        mock.timers.reset();
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
        bots.forEach(b => b.close());
    });

    it('hands the same consultation id to another recorder bot, with the start and the start of the gap', async () => {
        const encounterId = await loseBot1();
        const before = await consultationOf(encounterId);
        const lastHeartbeat = new Date(clock - LOST_AFTER_MS).toISOString();

        await service.takeOverLostConsultations();

        const after = await consultationOf(encounterId);

        assert.equal(after.id, before.id);
        assert.equal(after.recorderBot, 'bot-2');
        assert.equal(after.recording, true);
        assert.equal(after.startedAt, before.startedAt);
        assert.deepEqual(bots[1].asked, [ {
            consultationId: before.id, gapSince: lastHeartbeat, hn: 'HN/1', startedAt: before.startedAt, takenFrom: 'bot-1'
        } ]);
    });

    it('does not take a consultation over twice, nor one whose recorder bot is not lost', async () => {
        const encounterId = await loseBot1();

        await service.takeOverLostConsultations();
        await service.takeOverLostConsultations();
        assert.equal(bots[1].asked.length, 1);

        // A new consultation on the bot that is alive stays where it is.
        const second = await call('POST', '/encounters', { hn: 'HN/2' });

        await service.takeOverLostConsultations();
        assert.equal((await consultationOf(second.body.id)).recorderBot, 'bot-2');
        assert.equal(bots[1].asked.length, 2);
        assert.equal((await consultationOf(encounterId)).recorderBot, 'bot-2');
    });

    it('does not take over the consultation of an encounter that is done', async () => {
        const encounterId = await loseBot1();

        assert.equal((await call('POST', `/encounters/${encounterId}/stage`, { stage: 'done' })).status, 200);
        await service.takeOverLostConsultations();

        assert.deepEqual(bots[1].asked, []);
        assert.equal((await consultationOf(encounterId)).recorderBot, 'bot-1');
    });

    it('leaves the consultation unrecorded, and says so, when no recorder bot has room', async () => {
        bots[1].capacity = 0;

        const encounterId = await loseBot1();

        await service.takeOverLostConsultations();
        await service.takeOverLostConsultations();

        const found = await consultationOf(encounterId);
        const entries = (await call('GET', '/audit?limit=50')).body.entries
            .filter((e: { kind: string; }) => e.kind === 'consultation_unrecorded');

        assert.equal(found.recording, false);
        assert.equal(found.recorderBot, 'bot-1');
        assert.equal(entries.length, 1, 'reported once');
        assert.equal(entries[0].encounterId, encounterId);
        assert.equal(entries[0].outcome, 'unrecorded');
        assert.ok(!JSON.stringify(entries).includes('HN/1'), 'no HN in the audit log');
        assert.deepEqual(bots[1].asked, []);
    });

    it('tells the coordinator\'s screen which rooms are not recorded', async () => {
        bots[1].capacity = 0;

        const encounterId = await loseBot1();

        prosodyRooms = [ { name: 'hn%2f1', occupants: [] } ];
        assert.equal((await service.rooms()).find(r => r.encounterId === encounterId)?.unrecorded, undefined);

        await service.takeOverLostConsultations();

        assert.equal((await service.rooms()).find(r => r.encounterId === encounterId)?.unrecorded, true);
    });

    it('takes over, after a restart of the coordinator, the consultation of a worker it was never heard from', async () => {
        await beat(bots[0]);
        await beat(bots[1]);

        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-1');

        // A new process over the same stored data: its registry has heard nobody yet, and bot-1 never speaks again.
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
        await boot();
        await beat(bots[1]);
        await service.takeOverLostConsultations();
        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-1', 'not yet: it may be about to speak');

        pass(LOST_AFTER_MS);
        await beat(bots[1]);
        await service.takeOverLostConsultations();

        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-2');
        assert.equal(bots[1].asked.at(-1)?.takenFrom, 'bot-1');
    });

    it('takes over the consultation of a worker whose line was removed from the list', async () => {
        await beat(bots[0]);
        await beat(bots[1]);

        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-1');

        writeFileSync(join(dir, 'workers.json'), JSON.stringify({ recorderBots: [ { id: bots[1].id, secret: bots[1].secret } ] }));
        pass(LOST_AFTER_MS);
        await beat(bots[1]);
        await service.takeOverLostConsultations();

        assert.equal((await consultationOf(started.body.id)).recorderBot, 'bot-2');
    });

    it('keeps telling the lost worker until it stops the consultation, even over a lost reply or a restart', async () => {
        const encounterId = await loseBot1();
        const { id } = await consultationOf(encounterId);

        await service.takeOverLostConsultations();

        assert.deepEqual((await beat(bots[0])).body.takenOver, [ id ]);
        assert.deepEqual((await beat(bots[0])).body.takenOver, [ id ], 'the first answer may have been lost');

        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
        await boot();
        assert.deepEqual((await beat(bots[0])).body.takenOver, [ id ], 'a restart forgets nothing');

        bots[0].running = [];
        assert.deepEqual((await beat(bots[0])).body.takenOver, [], 'it stopped');
    });

    it('tells the lost worker, when it is heard again, that its consultation was taken over', async () => {
        const encounterId = await loseBot1();
        const { id } = await consultationOf(encounterId);

        await service.takeOverLostConsultations();

        assert.deepEqual((await beat(bots[0])).body.takenOver, [ id ]);
        assert.deepEqual((await beat(bots[1])).body.takenOver, []);
    });

    it('takes over only the consultations still recording, not the ones that ended', async () => {
        // bot-2 has no room yet, so that every consultation starts on bot-1.
        bots[1].capacity = 0;
        await beat(bots[0]);
        await beat(bots[1]);

        const encounters: string[] = [];

        for (const hn of [ 'HN/1', 'HN/2', 'HN/3', 'HN/4' ]) {
            encounters.push((await call('POST', '/encounters', { hn })).body.id);
        }

        const [ live, ...ended ] = await Promise.all(encounters.map(consultationOf));

        assert.deepEqual([ live, ...ended ].map(c => c.recorderBot), [ 'bot-1', 'bot-1', 'bot-1', 'bot-1' ]);

        // Everyone left three of the rooms: bot-1 runs only the first consultation now, and says so.
        bots[0].running = [ live.id ];
        pass(2 * HEARTBEAT_MS + 1);
        await beat(bots[0]);

        // Then bot-1 is lost, while bot-2 has room for two.
        bots[1].capacity = 2;
        pass(LOST_AFTER_MS);
        await beat(bots[1]);
        await service.takeOverLostConsultations();

        assert.deepEqual(bots[1].asked.map(a => a.consultationId), [ live.id ]);
        assert.equal((await consultationOf(encounters[0])).recorderBot, 'bot-2');
        for (const encounterId of encounters.slice(1)) {
            const consultation = await consultationOf(encounterId);

            assert.equal(consultation.recorderBot, 'bot-1');
            assert.ok(consultation.endedAt, 'it ended');
        }

        const unrecorded = (await call('GET', '/audit?limit=50')).body.entries
            .filter((e: { kind: string; }) => e.kind === 'consultation_unrecorded');

        assert.deepEqual(unrecorded, []);
    });

    it('marks ended a consultation the recorder bot\'s heartbeat no longer lists, once it is not just handed out', async () => {
        await beat(bots[0]);
        await beat(bots[1]);

        const first = (await call('POST', '/encounters', { hn: 'HN/1' })).body.id;
        const second = (await call('POST', '/encounters', { hn: 'HN/2' })).body.id;

        assert.deepEqual([ (await consultationOf(first)).recorderBot, (await consultationOf(second)).recorderBot ], [ 'bot-1', 'bot-1' ]);
        bots[0].running = [ (await consultationOf(second)).id ];

        // A heartbeat sent just before the recorder bot took a consultation does not list it yet.
        await beat(bots[0]);
        assert.equal((await consultationOf(first)).endedAt, undefined);

        pass(2 * HEARTBEAT_MS + 1);
        await beat(bots[0]);

        assert.equal((await consultationOf(first)).endedAt, new Date(clock).toISOString());
        assert.equal((await consultationOf(second)).endedAt, undefined);
    });

    it('marks nothing ended for a heartbeat that does not list its consultations (an older recorder bot)', async () => {
        await beat(bots[0]);

        const encounterId = (await call('POST', '/encounters', { hn: 'HN/1' })).body.id;
        const { body, status } = await call('POST', '/workers/heartbeat', {
            build: 'b1', capacity: 5, id: 'bot-1', kind: 'recorder-bot', running: 0, url: bots[0].url
        }, bots[0].secret);

        assert.equal(status, 200);
        assert.deepEqual(body.takenOver, []);
        pass(2 * HEARTBEAT_MS + 1);
        await call('POST', '/workers/heartbeat', {
            build: 'b1', capacity: 5, id: 'bot-1', kind: 'recorder-bot', running: 0, url: bots[0].url
        }, bots[0].secret);

        assert.equal((await consultationOf(encounterId)).endedAt, undefined);
    });

    it('does not mark ended a consultation just taken over, which the taker\'s heartbeat does not list yet', async () => {
        const encounterId = await loseBot1();

        await service.takeOverLostConsultations();
        assert.equal((await consultationOf(encounterId)).recorderBot, 'bot-2');

        // Sent by bot-2 before it took the consultation over, which started long ago, and arriving after.
        await call('POST', '/workers/heartbeat', {
            build: 'b1', capacity: 2, consultations: [], id: 'bot-2', kind: 'recorder-bot', running: 0, url: bots[1].url
        }, bots[1].secret);

        assert.equal((await consultationOf(encounterId)).endedAt, undefined);

        pass(2 * HEARTBEAT_MS + 1);
        await beat(bots[1]);
        assert.equal((await consultationOf(encounterId)).endedAt, undefined, 'it lists it now');
    });

    it('keeps telling the lost worker to stop a consultation that was taken over, after it ended on the taker', async () => {
        const encounterId = await loseBot1();
        const { id } = await consultationOf(encounterId);

        await service.takeOverLostConsultations();
        bots[1].running = [];
        pass(2 * HEARTBEAT_MS + 1);
        await beat(bots[1]);
        assert.ok((await consultationOf(encounterId)).endedAt, 'it ended on bot-2');

        assert.deepEqual((await beat(bots[0])).body.takenOver, [ id ]);
    });
});
