import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const SAM = { id: 's-1', name: 'Sam' };
const DOC = { id: 'd-1', name: 'Doc' };
const staffAt = (id: string, endpointId: string) =>
    ({ endpointId, hidden: false, identity: { user: { hospital_role: 'staff', id, name: id } } });
const patientRoom = (hn: string) => ({
    name: hn,
    occupants: [ { endpointId: `e-${hn}`, hidden: false, identity: { user: { hospital_role: 'patient', id: `p-${hn}` } } } as unknown ]
});
const lounge = (name: string, ...staff: unknown[]) => ({ name, occupants: staff });
const later = (ms = 5) => new Promise(resolve => setTimeout(resolve, ms));

describe('staff in a lounge see their station\'s queue (#24)', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        rooms = [];
        store = new Store(mkdtempSync(join(tmpdir(), 'lounge-queue-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: {
                centers: [ {
                    id: 'c1',
                    stations: [
                        { id: 'pharmacy', lounge: 'lounge-pharmacy', stages: [ 'pharmacy' ] },
                        { id: 'examination', lounge: 'lounge-exam', stages: [ 'examination' ] },
                        { id: 'nurse', lounge: 'lounge-nurse', stages: [ 'intake', 'aftercare' ] }
                    ]
                } ]
            },
            prosody: {
                rooms: async () => ({ rooms }),
                sendMove: async () => undefined
            } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            staffReadRoomsMs: 0,
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
    });

    afterEach(() => {
        service.stop();
        store.close();
    });

    /**
     * Starts an encounter and puts it in a stage.
     *
     * @param {string} hn - The HN.
     * @param {string} stage - The stage.
     * @returns {Promise<string>} The encounter's id.
     */
    async function enter(hn: string, stage: string): Promise<string> {
        const { encounter } = await service.startEncounter(hn);

        await service.changeStage(encounter?.id as string, stage, 'coord-1');
        await later();

        return encounter?.id as string;
    }

    it('counts the patients waiting in the station\'s stage, with the longest wait and the latest arrival', async () => {
        await enter('hn-a', 'pharmacy');
        await later(20);
        await enter('hn-b', 'pharmacy');
        await enter('hn-c', 'examination');
        rooms = [ lounge('lounge-pharmacy', staffAt('s-1', 'e-sam')), patientRoom('hn-a'), patientRoom('hn-b'), patientRoom('hn-c') ];

        const queue = (await service.staffContext(SAM)).queue;
        const [ first, second ] = service.queues().pharmacy;

        assert.equal(queue?.waiting, 2);
        assert.equal(typeof queue?.longestWaitSeconds, 'number');
        assert.equal(queue?.lastJoinedAt, second.enteredAt.toISOString());
        assert.ok(first.enteredAt < second.enteredAt);
    });

    it('counts the patients of every stage a station serves (ADR 0018)', async () => {
        await enter('hn-a', 'intake');
        await enter('hn-b', 'aftercare');
        await enter('hn-c', 'pharmacy');
        rooms = [ lounge('lounge-nurse', staffAt('s-1', 'e-sam')), patientRoom('hn-a'), patientRoom('hn-b'), patientRoom('hn-c') ];

        const queue = (await service.staffContext(SAM)).queue;

        assert.equal(queue?.waiting, 2);
        assert.equal(queue?.lastJoinedAt, service.queues().aftercare[0].enteredAt.toISOString());
    });

    it('leaves out a patient who already has staff with them, or whose room is not open', async () => {
        await enter('hn-a', 'pharmacy');
        await enter('hn-b', 'pharmacy');
        await enter('hn-gone', 'pharmacy');

        const served = patientRoom('hn-a');

        served.occupants.push(staffAt('s-2', 'e-two'));
        rooms = [ lounge('lounge-pharmacy', staffAt('s-1', 'e-sam')), served, patientRoom('hn-b') ];

        assert.equal((await service.staffContext(SAM)).queue?.waiting, 1);
    });

    it('gives an empty queue a count of nought and nothing else', async () => {
        rooms = [ lounge('lounge-pharmacy', staffAt('s-1', 'e-sam')) ];

        assert.deepEqual((await service.staffContext(SAM)).queue, { waiting: 0 });
    });

    it('gives a doctor only their own examination queue', async () => {
        const mine = await enter('hn-a', 'examination');
        const theirs = await enter('hn-b', 'examination');

        await enter('hn-c', 'examination');
        await service.setDoctor(mine, 'd-1', 'coord-1');
        await service.setDoctor(theirs, 'd-2', 'coord-1');
        rooms = [ lounge('lounge-exam', staffAt('d-1', 'e-doc')), patientRoom('hn-a'), patientRoom('hn-b'), patientRoom('hn-c') ];

        assert.equal((await service.staffContext(DOC)).queue?.waiting, 1);
    });

    it('carries no patient data', async () => {
        await enter('hn-secret', 'pharmacy');
        rooms = [ lounge('lounge-pharmacy', staffAt('s-1', 'e-sam')), patientRoom('hn-secret') ];

        const context = await service.staffContext(SAM);

        assert.equal(context.queue?.waiting, 1);
        assert.doesNotMatch(JSON.stringify(context), /hn-secret|p-hn-secret/);
    });

    it('gives no queue to staff in a patient\'s room', async () => {
        await enter('hn-a', 'pharmacy');

        const served = patientRoom('hn-a');

        served.occupants.push(staffAt('s-1', 'e-sam'));
        rooms = [ lounge('lounge-pharmacy'), served ];

        const context = await service.staffContext(SAM);

        assert.equal(context.where, 'patients_room');
        assert.equal(context.queue, undefined);
    });
});
