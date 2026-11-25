import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it, mock } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import { signToken } from '../src/jwt.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { createScreenRoutes } from '../src/screenRoutes.ts';
import { Store } from '../src/store.ts';

const pair = () => generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const hospital = pair();
const own = pair();

const LAYOUT: ILayout = { centers: [ { clinics: [ { id: 'med' }, { id: 'gyn' } ], id: 'c1', stations: [] } ] };

/** The parts of today's figures these tests read. */
interface IFigures {
    averageSeconds?: number;
    done: number;
    hours: { done: number; hour: number; started: number; }[];
    longest?: { seconds: number; since: string; stage: string; };
    stages: { averageSeconds?: number; id: string; }[];
    started: number;
}

/**
 * A moment of a day of November 2026 in Bangkok.
 *
 * @param {string} time - `HH:MM`.
 * @param {number} day - The day of the month; today is the 26th.
 * @returns {number} Milliseconds since the epoch.
 */
function at(time: string, day = 26): number {
    return Date.parse(`2026-11-${day}T${time}:00+07:00`);
}

/**
 * The averages of the stages that have one, by stage.
 *
 * @param {IFigures} figures - The figures.
 * @returns {Object}
 */
function averages(figures: IFigures): Record<string, number> {
    return Object.fromEntries(figures.stages.filter(s => s.averageSeconds !== undefined)
        .map(s => [ s.id, s.averageSeconds as number ]));
}

describe('today\'s figures of the coordinator screen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'today-figures-'));
    let server: Server;
    let service: CoordinatorService;
    let store: Store;
    let base: string;

    /**
     * Starts a service over the saved encounters.
     *
     * @returns {void}
     */
    function startService(): void {
        store = new Store(dir);
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: LAYOUT,
            prosody: { rooms: async () => ({ rooms: [] }), sendMove: async () => undefined } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey: own.privateKey },
            store,
            timeZone: 'Asia/Bangkok',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
    }

    /**
     * Serves the screen's routes over the service.
     *
     * @returns {Promise<void>}
     */
    async function listen(): Promise<void> {
        const handle = createScreenRoutes({
            act: async () => false,
            screen: {
                acceptedAudiences: [ 'jitsi' ],
                acceptedIssuers: [ 'chat' ],
                keyFor: async () => hospital.publicKey,
                marker: parseRoleMarker('user.hospital_role=coordinator', 'X') as never
            },
            service
        });

        server = createServer((req, res) => {
            handle(req, res, req.headers.authorization?.replace('Bearer ', '')).catch(() => {
                res.writeHead(500).end();
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/screen/api`;
    }

    /**
     * Reads today's figures as a coordinator's screen does.
     *
     * @param {string} query - The query, with its `?`, or none.
     * @returns {Promise<IFigures>}
     */
    async function today(query = ''): Promise<IFigures> {
        const now = Math.floor(Date.now() / 1000);
        const jwt = signToken({
            claims: {
                aud: 'jitsi',
                context: { user: { hospital_role: 'coordinator', id: 'coord-1' } },
                exp: now + 3600,
                iss: 'chat',
                nbf: now - 60,
                sub: 'meet.jitsi'
            },
            kid: 'hospital/key',
            privateKey: hospital.privateKey
        });
        const response = await fetch(`${base}/today${query}`, { headers: { authorization: `Bearer ${jwt}` } });

        assert.equal(response.status, 200);

        return await response.json() as IFigures;
    }

    /**
     * Starts an encounter at a moment.
     *
     * @param {number} when - The moment.
     * @param {string} hn - The patient's HN.
     * @param {string} clinic - The clinic.
     * @returns {Promise<string>} The encounter's id.
     */
    async function start(when: number, hn: string, clinic: string): Promise<string> {
        mock.timers.setTime(when);

        const { encounter, refused } = await service.startEncounter(hn, { clinic });

        assert.equal(refused, undefined);

        return encounter?.id ?? '';
    }

    /**
     * Sends an encounter to a stage at a moment.
     *
     * @param {number} when - The moment.
     * @param {string} id - The encounter.
     * @param {string} to - The stage.
     * @returns {Promise<void>}
     */
    async function send(when: number, id: string, to: string): Promise<void> {
        mock.timers.setTime(when);
        assert.equal((await service.changeStage(id, to, 'coord-1')).refused, undefined);
    }

    before(async () => {
        mock.timers.enable({ apis: [ 'Date', 'setTimeout' ], now: at('22:00', 25) });
        startService();
        service.startDayEnds();

        // Yesterday: one finished before midnight, and one left for the midnight close.
        const finished = await start(at('22:00', 25), 'HN-A', 'med');

        await send(at('22:50', 25), finished, 'done');

        const abandoned = await start(at('22:55', 25), 'HN-B', 'med');

        await send(at('23:00', 25), abandoned, 'intake');

        // The midnight close runs on its own timer.
        mock.timers.tick(at('00:00') - Date.now());
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(service.state.encounters.find(e => e.id === abandoned)?.unfinished, true);
        service.stop();

        // Today, read at 11:00.
        const first = await start(at('08:00'), 'HN-1', 'med');

        await send(at('08:10'), first, 'intake');
        await send(at('08:20'), first, 'examination');

        const second = await start(at('08:30'), 'HN-2', 'gyn');

        await send(at('08:50'), second, 'examination');
        await send(at('09:00'), first, 'done');

        const third = await start(at('09:15'), 'HN-3', 'med');

        await send(at('09:20'), second, 'done');
        await send(at('09:51'), third, 'intake');

        // The server and its client need real timers; the clock stays where the test puts it.
        mock.timers.reset();
        mock.timers.enable({ apis: [ 'Date' ], now: at('11:00') });
        await listen();
    });

    after(() => {
        mock.timers.reset();
        server.close();
        service.stop();
        store.close();
    });

    it('counts the encounters started today, and those that reached done today', async () => {
        const figures = await today();

        // Neither yesterday's finished encounter nor the one the midnight close ended counts.
        assert.equal(figures.started, 3);
        assert.equal(figures.done, 2);
    });

    it('averages the time from start to done over the encounters done today', async () => {
        // 08:00 to 09:00, and 08:30 to 09:20.
        assert.equal((await today()).averageSeconds, 55 * 60);
    });

    it('gives the longest single stretch in one stage today, an open one included', async () => {
        // The third patient has been in intake from 09:51 to now.
        assert.deepEqual((await today()).longest,
            { seconds: 69 * 60, since: new Date(at('09:51')).toISOString(), stage: 'intake' });
    });

    it('averages each stage over the stretches that ended today, leaving the open ones out', async () => {
        const figures = await today();

        // Waiting: 10, 20 and 36 minutes. Intake: the 10 minutes that ended, not the open stretch.
        assert.deepEqual(averages(figures), { examination: 35 * 60, intake: 10 * 60, waiting: 22 * 60 });
        assert.deepEqual(figures.stages.map(s => s.id),
            [ 'waiting', 'registration', 'intake', 'examination', 'aftercare', 'billing', 'pharmacy' ]);
    });

    it('counts the starts and completions of each hour, from the first to the one it is now', async () => {
        assert.deepEqual((await today()).hours, [
            { done: 0, hour: 8, started: 2 },
            { done: 2, hour: 9, started: 1 },
            { done: 0, hour: 10, started: 0 },
            { done: 0, hour: 11, started: 0 }
        ]);
    });

    it('gives the figures of one clinic', async () => {
        const gyn = await today('?clinic=gyn');

        assert.equal(gyn.started, 1);
        assert.equal(gyn.done, 1);
        assert.equal(gyn.averageSeconds, 50 * 60);
        assert.deepEqual(gyn.longest,
            { seconds: 30 * 60, since: new Date(at('08:50')).toISOString(), stage: 'examination' });
        assert.deepEqual(averages(gyn), { examination: 30 * 60, waiting: 20 * 60 });
        assert.deepEqual(gyn.hours.map(h => [ h.hour, h.started, h.done ]),
            [ [ 8, 1, 0 ], [ 9, 0, 1 ], [ 10, 0, 0 ], [ 11, 0, 0 ] ]);
    });

    it('has no average, longest wait or hours for a clinic with nothing today', async () => {
        const none = await today('?clinic=nobody');

        assert.equal(none.started, 0);
        assert.equal(none.done, 0);
        assert.equal('averageSeconds' in none, false);
        assert.equal('longest' in none, false);
        assert.deepEqual(averages(none), {});
        assert.deepEqual(none.hours, []);
    });

    it('keeps the day\'s done encounters over a restart and a retention sweep', async () => {
        const figures = await today();

        service.stop();
        server.close();
        store.close();
        startService();
        service.startRetention();
        await new Promise(resolve => setImmediate(resolve));
        await listen();

        assert.deepEqual(await today(), figures);
    });
});
