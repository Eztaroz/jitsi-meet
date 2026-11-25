import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import { type INhsoChecker, bypassCsv, dayOf, isDay } from '../src/nhso.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { initialState, step } from '../src/rules.ts';
import { Store } from '../src/store.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

let services: CoordinatorService[] = [];
let stores: Store[] = [];
let servers: Server[] = [];

afterEach(async () => {
    services.forEach(s => s.stop());
    stores.forEach(s => s.close());
    await Promise.all(servers.map(s => new Promise(resolve => s.close(resolve))));
    services = [];
    stores = [];
    servers = [];
});

/**
 * Makes a coordinator service on a fresh SQLite store.
 *
 * @param {Object} options - Options.
 * @param {INhsoChecker} [options.nhso] - The NHSO API, if there is one.
 * @param {Function} [options.fill] - Fills the store before the service reads it.
 * @param {string} [options.dir] - The store's directory, to open a store again; a fresh one by default.
 * @returns {Object} The service and its store.
 */
function make({ dir = mkdtempSync(join(tmpdir(), 'nhso-')), fill, nhso }: {
    dir?: string; fill?: (store: Store) => void; nhso?: INhsoChecker;
} = {}) {
    const store = new Store(dir);

    fill?.(store);

    const service = new CoordinatorService({
        auditKey: 'audit-key',
        layout: { centers: [ { id: 'c1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ] } ] },
        nhso,
        prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
        recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
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

    services.push(service);
    stores.push(store);

    return { service, store };
}

/**
 * The NHSO bypass entries of the audit log, the oldest first.
 *
 * @param {Store} store - The store.
 * @returns {Object[]}
 */
function bypassAudit(store: Store) {
    return store.audit(100).filter(e => e.kind === 'nhso_bypass')
        .reverse()
        .map(e => [ e.action, e.outcome, e.reason, e.issuer ]);
}

describe('days', () => {
    it('reads a moment\'s day in the deployment\'s time zone', () => {
        assert.equal(dayOf(new Date('2030-01-01T18:00:00Z'), 'Asia/Bangkok'), '2030-01-02');
        assert.equal(dayOf(new Date('2030-01-01T18:00:00Z'), 'UTC'), '2030-01-01');
    });

    it('takes only a day written as YYYY-MM-DD', () => {
        assert.equal(isDay('2030-01-31'), true);
        for (const value of [ '2030-1-31', '2030-13-01', '31/01/2030', '2030-01-31T00:00:00Z', '', undefined, 20300131 ]) {
            assert.equal(isDay(value), false, String(value));
        }
    });
});

describe('the list of the encounters of bypass days', () => {
    it('is CSV with a byte order mark, a row per encounter, times in the time zone', () => {
        const day = { day: '2030-01-02', declaredAt: new Date('2030-01-02T01:30:00Z'), declaredBy: 'coordinator-1' };
        const csv = bypassCsv([ {
            clinic: 'med', day, encounterId: 'e-1', hn: '6500001', startedAt: new Date('2030-01-02T02:00:00Z'), visitNumber: 'VN-1'
        } ], 'Asia/Bangkok');

        assert.equal(csv, '﻿day,declared_by,declared_at,encounter_id,hn,visit_number,clinic,started_at\r\n'
            + '2030-01-02,coordinator-1,2030-01-02 08:30:00,e-1,6500001,VN-1,med,2030-01-02 09:00:00\r\n');
    });
});

describe('declaring and cancelling an NHSO bypass day', () => {
    it('declares today once, and audits the second declaring as refused', async () => {
        const { service, store } = make();

        const first = await service.declareBypass('coordinator-1');
        const second = await service.declareBypass('coordinator-2');

        assert.equal(first.created, true);
        assert.equal(first.day.day, dayOf(new Date(), 'UTC'));
        assert.equal(second.created, false);
        assert.equal(second.day.declaredBy, 'coordinator-1');
        assert.equal(service.bypassToday()?.declaredBy, 'coordinator-1');
        assert.deepEqual(bypassAudit(store), [
            [ 'declare', 'ok', undefined, 'coordinator-1' ],
            [ 'declare', 'refused', 'already_declared', 'coordinator-2' ]
        ]);
    });

    it('cancels today\'s day, keeps who cancelled it, and refuses to cancel when there is none', async () => {
        const { service, store } = make();

        assert.deepEqual(await service.cancelBypass('coordinator-1'), { refused: 'no_bypass_today' });
        await service.declareBypass('coordinator-1');

        const { day } = await service.cancelBypass('coordinator-2');

        assert.equal(day?.cancelledBy, 'coordinator-2');
        assert.equal(service.bypassToday(), undefined);
        assert.equal(store.bypassDays(day?.day as string, day?.day as string)[0].cancelledBy, 'coordinator-2');
        assert.deepEqual(bypassAudit(store), [
            [ 'cancel', 'refused', 'no_bypass_today', 'coordinator-1' ],
            [ 'declare', 'ok', undefined, 'coordinator-1' ],
            [ 'cancel', 'ok', undefined, 'coordinator-2' ]
        ]);
    });

    it('keeps today\'s day over a restart', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'nhso-'));
        const first = make({ dir });

        await first.service.declareBypass('coordinator-1');
        first.service.stop();
        first.store.close();
        services = [];
        stores = [];

        assert.equal(make({ dir }).service.bypassToday()?.declaredBy, 'coordinator-1');
    });
});

describe('each open encounter\'s NHSO authentication', () => {
    it('is unavailable while there is no NHSO API, and bypassed on a bypass day', async () => {
        const { service } = make();
        const { encounter } = await service.startEncounter('6500001');
        const id = encounter?.id as string;

        await service.checkNhso();
        assert.deepEqual(service.nhsoStatuses(), { [id]: 'unavailable' });
        await service.declareBypass('coordinator-1');
        assert.deepEqual(service.nhsoStatuses(), { [id]: 'bypassed' });
    });

    it('follows what the NHSO API says, and is unavailable while it cannot be asked', async () => {
        let down = false;
        const asked: string[] = [];
        const { service } = make({
            nhso: {
                authenticated: async ({ hn }) => {
                    asked.push(hn);
                    if (down) {
                        throw new Error('down');
                    }

                    return hn === '6500001';
                }
            }
        });
        const a = (await service.startEncounter('6500001')).encounter?.id as string;
        const b = (await service.startEncounter('6500002')).encounter?.id as string;

        assert.deepEqual(service.nhsoStatuses(), { [a]: 'unavailable', [b]: 'unavailable' });
        await service.checkNhso();
        assert.deepEqual(service.nhsoStatuses(), { [a]: 'authenticated', [b]: 'not_yet' });

        down = true;
        asked.length = 0;
        await service.checkNhso();
        assert.deepEqual(asked, [ '6500002' ], 'an authenticated patient is not asked about again');
        assert.deepEqual(service.nhsoStatuses(), { [a]: 'authenticated', [b]: 'unavailable' });

        await service.declareBypass('coordinator-1');
        assert.deepEqual(service.nhsoStatuses(), { [a]: 'authenticated', [b]: 'bypassed' });

        down = false;
        await service.cancelBypass('coordinator-1');
        await service.checkNhso();
        assert.deepEqual(service.nhsoStatuses(), { [a]: 'authenticated', [b]: 'not_yet' });
    });

    it('leaves closed encounters out', async () => {
        const { service } = make();
        const { encounter } = await service.startEncounter('6500001');

        await service.changeStage(encounter?.id as string, 'done', 'coordinator-1');
        assert.deepEqual(service.nhsoStatuses(), {});
    });
});

describe('the report of the bypass days', () => {
    /**
     * Fills a store with an encounter on each of three days: a bypass day, a cancelled one, and an ordinary one.
     *
     * @param {Store} store - The store.
     * @returns {void}
     */
    function fill(store: Store): void {
        let state = initialState();

        for (const [ hn, at ] of [
            [ '6500002', '2030-01-10T09:00:00Z' ], [ '6500001', '2030-01-10T03:00:00Z' ],
            [ '6500003', '2030-01-11T03:00:00Z' ], [ '6500004', '2030-01-12T03:00:00Z' ]
        ]) {
            state = step(state, { at: new Date(at), hn, type: 'start_encounter' }).state;
        }
        store.apply(state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })));
        store.putBypassDay({ day: '2030-01-10', declaredAt: new Date('2030-01-10T02:00:00Z'), declaredBy: 'coordinator-1' });
        store.putBypassDay({
            cancelledAt: new Date('2030-01-11T02:05:00Z'), cancelledBy: 'coordinator-1', day: '2030-01-11',
            declaredAt: new Date('2030-01-11T02:00:00Z'), declaredBy: 'coordinator-1'
        });
    }

    it('lists only the encounters of the days not cancelled, the oldest first, and audits the export', () => {
        const { service, store } = make({ fill });

        const rows = service.bypassReport('2030-01-01', '2030-01-31', 'system').trim()
            .split('\r\n');

        assert.deepEqual(rows.slice(1).map(row => row.split(',')[4]), [ '6500001', '6500002' ]);
        assert.deepEqual(store.audit(1).map(e => [ e.kind, e.count, e.day, e.lastDay, e.issuer ]),
            [ [ 'nhso_bypass_export', 2, '2030-01-01', '2030-01-31', 'system' ] ]);
    });

    it('lists nothing outside the period', () => {
        const { service } = make({ fill });

        assert.equal(service.bypassReport('2030-01-11', '2030-01-31', 'system').trim()
            .split('\r\n').length, 1);
    });
});

describe('the NHSO bypass routes', () => {
    /**
     * Starts the API on a real service.
     *
     * @param {Function} [fill] - Fills the store first.
     * @returns {Promise<Object>}
     */
    async function start(fill?: (store: Store) => void) {
        const { service } = make({ fill });
        const server = createApi({ secret: SECRET, service });

        servers.push(server);
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
        const call = (path: string, method = 'GET') =>
            fetch(`${base}${path}`, { headers: { authorization: `Bearer ${SECRET}` }, method });

        return { call, service };
    }

    it('declares, shows and cancels today\'s day', async () => {
        const { call } = await start();

        assert.deepEqual(await (await call('/nhso/bypass')).json(), { bypass: null });

        const declared = await call('/nhso/bypass', 'POST');
        const again = await call('/nhso/bypass', 'POST');

        assert.equal(declared.status, 201);
        assert.equal(again.status, 200);
        assert.equal((await (await call('/nhso/bypass')).json()).bypass.declaredBy, 'system');

        const cancelled = await call('/nhso/bypass/cancel', 'POST');
        const none = await call('/nhso/bypass/cancel', 'POST');

        assert.equal(cancelled.status, 200);
        assert.equal((await cancelled.json()).bypass.cancelledBy, 'system');
        assert.equal(none.status, 409);
        assert.deepEqual(await none.json(), { error: 'no_bypass_today' });
        assert.deepEqual(await (await call('/nhso/bypass')).json(), { bypass: null });
    });

    it('gives an open encounter\'s NHSO authentication with the encounter', async () => {
        const { call, service } = await start();
        const { encounter } = await service.startEncounter('6500001');

        assert.equal((await (await call(`/encounters/${encounter?.id}`)).json()).nhso, 'unavailable');
    });

    it('exports the report as a CSV file', async () => {
        const { call } = await start(store => {
            store.apply([ { encounter: step(initialState(), { at: new Date('2030-01-10T03:00:00Z'), hn: '6500001',
                type: 'start_encounter' }).encounter as never, kind: 'encounter' } ]);
            store.putBypassDay({ day: '2030-01-10', declaredAt: new Date('2030-01-10T02:00:00Z'), declaredBy: 'coordinator-1' });
        });
        const report = await call('/nhso-bypass.csv?from=2030-01-01&to=2030-01-31');

        assert.equal(report.status, 200);
        assert.equal(report.headers.get('content-type'), 'text/csv; charset=utf-8');
        assert.match(report.headers.get('content-disposition') ?? '', /attachment; filename="nhso-bypass\.csv"/u);
        // The text of a response loses its byte order mark; its bytes keep it.
        assert.match(Buffer.from(await report.arrayBuffer()).toString('utf8'), /^﻿day,.*\r\n2030-01-10,coordinator-1,.*,6500001,/su);
    });

    it('refuses a period it cannot read', async () => {
        const { call } = await start();

        for (const query of [ 'from=yesterday', 'to=2030-1-31', 'from=2030-01-01&to=soon' ]) {
            assert.equal((await call(`/nhso-bypass.csv?${query}`)).status, 400, query);
        }
    });
});
