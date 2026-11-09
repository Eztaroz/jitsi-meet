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
const later = () => new Promise(resolve => setTimeout(resolve, 5));

describe('staff call the next patient, through the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let sent: { destination: string; endpointId: string; room: string; }[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        rooms = [];
        sent = [];
        store = new Store(mkdtempSync(join(tmpdir(), 'callnext-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: {
                centers: [ {
                    id: 'c1',
                    stations: [
                        { id: 'intake', lounge: 'lounge-intake', stage: 'intake' },
                        { id: 'examination', lounge: 'lounge-exam', stage: 'examination' }
                    ]
                } ]
            },
            prosody: {
                rooms: async () => ({ rooms }),
                sendMove: async ({ endpointId, move, room }: { endpointId: string; move: { destination: string; }; room: string; }) => {
                    sent.push({ destination: move.destination, endpointId, room });
                }
            } as unknown as Prosody,
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

    const lounge = (name: string, ...staff: unknown[]) => ({ name, occupants: staff });

    it('moves the staff member to the longest-waiting patient of their station\'s stage', async () => {
        await enter('hn-a', 'intake');
        await enter('hn-b', 'intake');
        await enter('hn-c', 'aftercare');
        rooms = [
            lounge('lounge-intake', staffAt('s-1', 'e-sam')), patientRoom('hn-b'), patientRoom('hn-a'), patientRoom('hn-c')
        ];

        const result = await service.staffCallNext(SAM);

        assert.equal(result.refused, undefined);
        assert.equal(result.moved, true);
        assert.deepEqual(sent.map(s => [ s.room, s.destination, s.endpointId ]), [ [ 'lounge-intake', 'hn-a', 'e-sam' ] ]);
    });

    it('skips a patient who already has staff with them', async () => {
        await enter('hn-a', 'intake');
        await enter('hn-b', 'intake');

        const withStaff = patientRoom('hn-a');

        withStaff.occupants.push(staffAt('s-2', 'e-other'));
        rooms = [ lounge('lounge-intake', staffAt('s-1', 'e-sam')), withStaff, patientRoom('hn-b') ];

        await service.staffCallNext(SAM);

        assert.deepEqual(sent.map(s => s.destination), [ 'hn-b' ]);
    });

    it('gives two staff pressing at once different patients', async () => {
        await enter('hn-a', 'intake');
        await enter('hn-b', 'intake');
        rooms = [
            lounge('lounge-intake', staffAt('s-1', 'e-sam'), staffAt('s-2', 'e-two')),
            patientRoom('hn-a'),
            patientRoom('hn-b')
        ];

        const results = await Promise.all([ service.staffCallNext(SAM), service.staffCallNext({ id: 's-2' }) ]);

        assert.deepEqual(results.map(r => r.moved), [ true, true ]);
        assert.deepEqual(sent.map(s => s.destination).sort(), [ 'hn-a', 'hn-b' ]);
    });

    it('never gives two staff the same single patient', async () => {
        await enter('hn-a', 'intake');
        rooms = [
            lounge('lounge-intake', staffAt('s-1', 'e-sam'), staffAt('s-2', 'e-two')),
            patientRoom('hn-a')
        ];

        const results = await Promise.all([ service.staffCallNext(SAM), service.staffCallNext({ id: 's-2' }) ]);

        assert.deepEqual(results.map(r => r.refused).sort(), [ 'queue_empty', undefined ]);
        assert.equal(sent.length, 1);
    });

    it('lets a doctor take only from their own examination queue', async () => {
        const mine = await enter('hn-a', 'examination');
        const theirs = await enter('hn-b', 'examination');

        await enter('hn-c', 'examination');
        await service.setDoctor(theirs, 'd-2', 'coord-1');
        await service.setDoctor(mine, 'd-1', 'coord-1');
        rooms = [
            lounge('lounge-exam', staffAt('d-1', 'e-doc')), patientRoom('hn-b'), patientRoom('hn-c'), patientRoom('hn-a')
        ];

        await service.staffCallNext(DOC);

        assert.deepEqual(sent.map(s => s.destination), [ 'hn-a' ]);
    });

    it('tells a doctor with nobody assigned that the queue is empty', async () => {
        await enter('hn-a', 'examination');
        rooms = [ lounge('lounge-exam', staffAt('d-1', 'e-doc')), patientRoom('hn-a') ];

        assert.equal((await service.staffCallNext(DOC)).refused, 'queue_empty');
        assert.deepEqual(sent, []);
    });

    it('gives a clear refusal and no move for an empty queue', async () => {
        rooms = [ lounge('lounge-intake', staffAt('s-1', 'e-sam')) ];

        const result = await service.staffCallNext(SAM);

        assert.equal(result.refused, 'queue_empty');
        assert.equal(result.moved, false);
        assert.deepEqual(sent, []);
    });

    it('refuses staff who are not in a station\'s lounge', async () => {
        await enter('hn-a', 'intake');
        rooms = [ patientRoom('hn-a') ];
        assert.equal((await service.staffCallNext(SAM)).refused, 'not_in_lounge');

        rooms = [ { name: 'hn-a', occupants: [ ...patientRoom('hn-a').occupants, staffAt('s-1', 'e-sam') ] } ];
        assert.equal((await service.staffCallNext(SAM)).refused, 'not_in_lounge');
        assert.deepEqual(sent, []);
    });

    it('audits each call with the staff member, and refusals too', async () => {
        const id = await enter('hn-a', 'intake');

        rooms = [ lounge('lounge-intake', staffAt('s-1', 'e-sam')), patientRoom('hn-a') ];
        await service.staffCallNext(SAM);
        rooms = [ lounge('lounge-intake', staffAt('s-9', 'e-nine')) ];
        await service.staffCallNext({ id: 's-9' });

        const calls = service.audit(50).filter(e => e.kind === 'call_next')
            .map(e => [ e.issuer, e.encounterId ?? '', e.outcome, e.reason ?? '' ].join('|'));

        assert.deepEqual(calls.sort(), [ `s-1|${id}|ok|`, 's-9||refused|queue_empty' ]);
    });
});
