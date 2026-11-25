import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import { signToken } from '../src/jwt.ts';
import { DatabaseError } from '../src/mariadbClient.ts';
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

const stagesOf = (...ids: string[]) => ids.map(id => ({ id, name: id.toUpperCase() }));

/** A center with a clinic that follows its own, shorter pathway and has a name, and one without a name. */
const LAYOUT: ILayout = {
    centers: [ {
        clinics: [ { id: 'gyn', name: 'นรีเวช', pathway: 'short' }, { id: 'med' } ],
        id: 'c1',
        pathways: [ { id: 'short', stages: stagesOf('waiting', 'examination', 'done') } ],
        stations: [ { id: 'examination', lounge: 'lounge-exam', stages: [ 'examination' ] } ]
    } ]
};

/** A queue entry as the screen reads it. */
interface IScreenEntry {
    clinic?: string;
    encounterId: string;
    hn?: string;
    pathwayStages: string[];
}

/** The parts of the screen's state these tests read. */
interface IScreenState {
    clinics: { id: string; name: string; }[];
    examination: { doctors: Record<string, IScreenEntry[]>; unassigned: IScreenEntry[]; };
    queues: Record<string, IScreenEntry[]>;
}

describe('the state of the coordinator screen', () => {
    let server: Server;
    let service: CoordinatorService;
    let state: () => Promise<IScreenState>;
    let read: () => Promise<Response>;
    let store: Store;

    /**
     * Starts an encounter.
     *
     * @param {string} hn - The patient's HN.
     * @param {Object} where - The clinic, if any.
     * @returns {Promise<string>} The encounter's id.
     */
    async function start(hn: string, where: { clinic?: string; } = {}): Promise<string> {
        const { encounter, refused } = await service.startEncounter(hn, where);

        assert.equal(refused, undefined);

        return encounter?.id ?? '';
    }

    /**
     * Finds an encounter's entry in the queue of its stage.
     *
     * @param {Object} from - The state.
     * @param {string} id - The encounter's id.
     * @returns {Object}
     */
    function entryOf(from: IScreenState, id: string): IScreenEntry {
        const found = Object.values(from.queues).flat()
            .find(e => e.encounterId === id);

        assert.ok(found, `no queue has the encounter ${id}`);

        return found;
    }

    /**
     * Starts a service over a layout, and the screen's routes over it.
     *
     * @param {Object} layout - The layout.
     * @returns {Promise<void>}
     */
    async function open(layout: ILayout): Promise<void> {
        store = new Store(mkdtempSync(join(tmpdir(), 'screen-state-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout,
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

        server = createServer((req, res) => {
            handle(req, res, req.headers.authorization?.replace('Bearer ', '')).catch(error => {
                // As the service's server answers: the error's own status and message.
                res.writeHead(error.status ?? 500, { 'content-type': 'application/json' })
                    .end(JSON.stringify({ error: error.message }));
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/screen/api/state`;

        read = () => fetch(url, { headers: { authorization: `Bearer ${jwt}` } });
        state = async () => {
            const response = await read();

            assert.equal(response.status, 200);

            return await response.json() as IScreenState;
        };
    }

    afterEach(() => {
        server.close();
        service.stop();
        store.close();
    });

    it('says that it is the database that cannot be asked, so that the screen can name that trouble', async () => {
        await open(LAYOUT);
        store.consultationsByRecording = () => {
            throw new DatabaseError('the database did not answer in time');
        };

        const response = await read();

        assert.equal(response.status, 503);
        assert.deepEqual(await response.json(), { error: 'database' });
    });

    describe('of a center with clinics', () => {
        beforeEach(() => open(LAYOUT));

        it('lists the center\'s clinics, one without a name by its id', async () => {
            assert.deepEqual((await state()).clinics, [ { id: 'gyn', name: 'นรีเวช' }, { id: 'med', name: 'med' } ]);
        });

        it('names the encounter\'s clinic on its queue entry, and none for an encounter without one', async () => {
            const gyn = await start('HN1', { clinic: 'gyn' });
            const none = await start('HN2');
            const now = await state();

            assert.equal(entryOf(now, gyn).clinic, 'gyn');
            assert.equal(entryOf(now, gyn).hn, 'HN1');
            assert.equal('clinic' in entryOf(now, none), false);
        });

        it('carries the clinic on the entries of examination\'s queues by doctor too', async () => {
            const assigned = await start('HN1', { clinic: 'gyn' });
            const unassigned = await start('HN2', { clinic: 'med' });

            await service.changeStage(assigned, 'examination', 'coord-1');
            await service.changeStage(unassigned, 'examination', 'coord-1');
            await service.setDoctor(assigned, 'd-1', 'coord-1');

            const { examination } = await state();

            assert.deepEqual(examination.doctors['d-1']?.map(e => [ e.encounterId, e.hn, e.clinic ]),
                [ [ assigned, 'HN1', 'gyn' ] ]);
            assert.deepEqual(examination.unassigned.map(e => [ e.encounterId, e.hn, e.clinic ]),
                [ [ unassigned, 'HN2', 'med' ] ]);
        });

        it('gives each entry the stages of its encounter\'s own pathway, in order', async () => {
            const short = await start('HN1', { clinic: 'gyn' });
            const usual = await start('HN2', { clinic: 'med' });
            const now = await state();

            assert.deepEqual(entryOf(now, short).pathwayStages, [ 'waiting', 'examination', 'done' ]);
            assert.deepEqual(entryOf(now, usual).pathwayStages,
                [ 'waiting', 'registration', 'intake', 'examination', 'aftercare', 'billing', 'pharmacy', 'done' ]);
        });
    });

    describe('of a center without clinics', () => {
        beforeEach(() => open({ centers: [ { id: 'c1', stations: [] } ] }));

        it('lists no clinic', async () => {
            assert.deepEqual((await state()).clinics, []);
        });
    });
});
