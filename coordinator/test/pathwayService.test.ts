import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, type IPathway, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

/** The built-in SQLite, which the installed typings do not know yet. */
const { DatabaseSync } = process.getBuiltinModule('node:sqlite') as unknown as {
    DatabaseSync: new (file: string) => { close: () => void; exec: (sql: string) => void; prepare: (sql: string) => { run: (...args: unknown[]) => void; }; };
};

const stage = (id: string, name = id) => ({ id, name });
const SHORT: IPathway = { id: 'short', stages: [ stage('waiting', 'W'), stage('examination', 'E'), stage('done', 'D') ] };
const stations = [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ];
const DEFAULT_LAYOUT: ILayout = { centers: [ { id: 'c1', stations } ] };
const CLINIC_LAYOUT: ILayout = {
    centers: [ { clinics: [ { id: 'gyn', pathway: 'short' }, { id: 'med' } ], id: 'c1', pathways: [ SHORT ], stations } ]
};

describe('encounters and pathways, through the coordinator service', () => {
    let dir: string;
    let service: CoordinatorService;
    let store: Store;

    /**
     * Starts a service over the store in the directory, as the process does.
     *
     * @param {ILayout} layout - The configured layout.
     * @returns {CoordinatorService}
     */
    function boot(layout: ILayout): CoordinatorService {
        store = new Store(dir);

        return new CoordinatorService({
            auditKey: 'audit-key',
            layout,
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
    }

    /**
     * Stops the service and starts another, on the same store, with a layout.
     *
     * @param {ILayout} layout - The layout of the new service.
     * @returns {void}
     */
    function restart(layout: ILayout): void {
        service.stop();
        store.close();
        service = boot(layout);
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'pathway-'));
        service = boot(CLINIC_LAYOUT);
    });

    afterEach(() => {
        service.stop();
        store.close();
    });

    const encounterOf = async (hn: string, where: { center?: string; clinic?: string; visitNumber?: string; } = {}) => {
        const result = await service.startEncounter(hn, where);

        return result.encounter as NonNullable<typeof result.encounter>;
    };

    describe('starting an encounter', () => {
        it('takes an optional visit number, center and clinic, and follows the clinic\'s pathway', async () => {
            const e = await encounterOf('HN/1', { center: 'c1', clinic: 'gyn', visitNumber: 'VN-9' });

            assert.deepEqual([ e.pathway, e.visitNumber, e.center, e.clinic ], [ 'short', 'VN-9', 'c1', 'gyn' ]);
        });

        it('follows the default pathway without them', async () => {
            const e = await encounterOf('HN/2');

            assert.deepEqual([ e.pathway, e.visitNumber, e.clinic ], [ 'default', undefined, undefined ]);
            assert.equal(e.center, 'c1');
        });

        it('refuses an unknown center or clinic, and starts nothing', async () => {
            const center = await service.startEncounter('HN/3', { center: 'nope' });
            const clinic = await service.startEncounter('HN/3', { clinic: 'nope' });

            assert.equal(center.refused, 'unknown_center');
            assert.equal(clinic.refused, 'unknown_clinic');
            assert.equal(center.encounter, undefined);
            assert.equal(service.state.encounters.length, 0);
        });
    });

    describe('changing a stage', () => {
        it('is refused for a stage outside the encounter\'s pathway, and allowed inside it', async () => {
            const short = await encounterOf('HN/4', { clinic: 'gyn' });
            const outside = await service.changeStage(short.id, 'billing', 'system');
            const inside = await service.changeStage(short.id, 'examination', 'system');
            const closes = await service.changeStage(short.id, 'done', 'system');

            assert.equal(outside.refused, 'stage_not_in_pathway');
            assert.equal(inside.encounter?.stage, 'examination');
            assert.equal(closes.encounter?.stage, 'done');
        });

        it('lets the default pathway reach registration, billing and pharmacy', async () => {
            const e = await encounterOf('HN/5', { clinic: 'med' });

            for (const to of [ 'registration', 'billing', 'pharmacy' ]) {
                assert.equal((await service.changeStage(e.id, to, 'system')).encounter?.stage, to);
            }
        });

        it('audits the refusal', async () => {
            const e = await encounterOf('HN/6', { clinic: 'gyn' });

            await service.changeStage(e.id, 'billing', 'system');

            assert.equal(service.audit(10).find(a => a.kind === 'stage')?.outcome, 'refused');
        });
    });

    describe('the stages and queues', () => {
        it('follow the configured pathways, with their names', async () => {
            await encounterOf('HN/7', { clinic: 'gyn' });
            const queues = service.queues();

            assert.deepEqual(service.stages().map(s => s.id),
                [ 'waiting', 'registration', 'intake', 'examination', 'aftercare', 'billing', 'pharmacy', 'done' ]);
            assert.equal(service.stages().find(s => s.id === 'examination')?.name, 'พบแพทย์');
            assert.equal(queues.waiting.length, 1);
            assert.deepEqual(Object.keys(queues).includes('done'), false);
            assert.ok(Object.keys(queues).includes('pharmacy'));
        });
    });

    describe('after a restart', () => {
        it('refuses a configuration that removes a stage holding open encounters, naming the stage and the count', async () => {
            const a = await encounterOf('HN/8');
            const b = await encounterOf('HN/9');

            await service.changeStage(a.id, 'billing', 'system');
            await service.changeStage(b.id, 'billing', 'system');

            const trimmed: ILayout = {
                centers: [ { id: 'c1', pathways: [ { id: 'default', stages: [ stage('waiting'), stage('examination'), stage('done') ] } ], stations: [] } ]
            };

            assert.throws(() => restart(trimmed), /"billing".*2 open encounters/u);
        });

        it('starts with a configuration that removes a stage nobody is in', async () => {
            await encounterOf('HN/10');

            const trimmed: ILayout = {
                centers: [ { id: 'c1', pathways: [ { id: 'default', stages: [ stage('waiting'), stage('examination'), stage('done') ] } ], stations: [] } ]
            };

            restart(trimmed);

            assert.equal(service.state.encounters.length, 1);
        });

        it('keeps an encounter\'s pathway, visit number, center and clinic', async () => {
            const e = await encounterOf('HN/11', { center: 'c1', clinic: 'gyn', visitNumber: 'VN-1' });

            restart(CLINIC_LAYOUT);

            const kept = service.state.encounters.find(x => x.id === e.id);

            assert.deepEqual([ kept?.pathway, kept?.visitNumber, kept?.center, kept?.clinic ], [ 'short', 'VN-1', 'c1', 'gyn' ]);
        });
    });

    describe('the history of an encounter', () => {
        it('names a stage by its id once the configuration no longer has it', async () => {
            const e = await encounterOf('HN/12');

            await service.changeStage(e.id, 'billing', 'system');
            await service.changeStage(e.id, 'done', 'system');
            restart({ centers: [ { id: 'c1', pathways: [ { id: 'default', stages: [ stage('waiting', 'W'), stage('done', 'D') ] } ], stations: [] } ] });

            const history = service.describeEncounter(e.id)?.history.map(h => [ h.stage, h.name ]);

            assert.deepEqual(history, [ [ 'waiting', 'W' ], [ 'billing', 'billing' ], [ 'done', 'D' ] ]);
        });
    });

    describe('an encounter stored before pathways', () => {
        it('still loads, on the default pathway', () => {
            service.stop();
            store.close();

            const old = mkdtempSync(join(tmpdir(), 'pathway-old-'));
            const db = new DatabaseSync(join(old, 'coordinator.sqlite'));

            db.exec('CREATE TABLE encounters (id TEXT PRIMARY KEY, hn TEXT NOT NULL, stage TEXT NOT NULL, started_at TEXT NOT NULL)');
            db.prepare('INSERT INTO encounters VALUES (?, ?, ?, ?)').run('old-1', 'HN/OLD', 'intake', '2030-01-01T08:00:00.000Z');
            db.close();
            dir = old;
            service = boot(DEFAULT_LAYOUT);

            const loaded = service.state.encounters[0];

            assert.deepEqual([ loaded.id, loaded.stage, loaded.pathway ], [ 'old-1', 'intake', 'default' ]);
        });
    });
});
