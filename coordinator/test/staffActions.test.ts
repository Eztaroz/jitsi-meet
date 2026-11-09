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
const staffAt = (id: string, endpointId: string) =>
    ({ endpointId, hidden: false, identity: { user: { hospital_role: 'staff', id, name: id } } });
const patientAt = { endpointId: 'e-pat', hidden: false, identity: { user: { hospital_role: 'patient', id: 'p-1' } } };

describe('staff change a stage, through the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let sent: { destination: string; endpointId: string; room: string; }[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        rooms = [];
        sent = [];
        store = new Store(mkdtempSync(join(tmpdir(), 'staff-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [ { id: 'c1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ] } ] },
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
     * Starts an encounter, and puts Sam in the patient's room after Sam was seen in the station's lounge.
     *
     * @returns {Promise<string>} The encounter's id.
     */
    async function samInPatientsRoom(): Promise<string> {
        const { encounter } = await service.startEncounter('hn-1');

        rooms = [ { name: 'lounge-intake', occupants: [ staffAt('s-1', 'e-sam') ] }, { name: 'hn-1', occupants: [ patientAt ] } ];
        await service.rooms();
        rooms = [ { name: 'hn-1', occupants: [ patientAt, staffAt('s-1', 'e-sam') ] } ];

        return encounter?.id as string;
    }

    it('changes the stage forward or back, to any stage but done, and moves the staff member to their lounge', async () => {
        const id = await samInPatientsRoom();

        const forward = await service.staffChangeStage(id, 'billing', SAM);

        assert.equal(forward.refused, undefined);
        assert.equal(service.state.encounters[0].stage, 'billing');
        assert.deepEqual(sent.map(s => [ s.room, s.destination, s.endpointId ]), [ [ 'hn-1', 'lounge-intake', 'e-sam' ] ]);

        const back = await service.staffChangeStage(id, 'waiting', SAM);

        assert.equal(back.refused, undefined);
        assert.equal(service.state.encounters[0].stage, 'waiting');
    });

    it('refuses done for staff, and leaves the stage and the staff member where they are', async () => {
        const id = await samInPatientsRoom();

        const result = await service.staffChangeStage(id, 'done', SAM);

        assert.equal(result.refused, 'done_is_not_for_staff');
        assert.equal(service.state.encounters[0].stage, 'waiting');
        assert.deepEqual(sent, []);
    });

    it('still lets the coordinator set done', async () => {
        const id = await samInPatientsRoom();

        assert.equal((await service.changeStage(id, 'done', 'coord-1')).refused, undefined);
    });

    it('refuses a staff member who is not in that patient\'s room', async () => {
        const id = await samInPatientsRoom();

        rooms = [ { name: 'lounge-intake', occupants: [ staffAt('s-1', 'e-sam') ] }, { name: 'hn-1', occupants: [ patientAt ] } ];
        assert.equal((await service.staffChangeStage(id, 'billing', SAM)).refused, 'not_in_patients_room');

        rooms = [ { name: 'hn-1', occupants: [ patientAt, staffAt('s-2', 'e-other') ] } ];
        assert.equal((await service.staffChangeStage(id, 'billing', SAM)).refused, 'not_in_patients_room');
        assert.equal(service.state.encounters[0].stage, 'waiting');
        assert.deepEqual(sent, []);
    });

    it('refuses a stage that is not in the pathway, and an unknown encounter', async () => {
        const id = await samInPatientsRoom();

        assert.equal((await service.staffChangeStage(id, 'nonsense', SAM)).refused, 'stage_not_in_pathway');
        assert.equal((await service.staffChangeStage('nope', 'billing', SAM)).refused, 'unknown_encounter');
    });

    it('audits each change with the staff member, the encounter and the old and new stages', async () => {
        const id = await samInPatientsRoom();

        await service.staffChangeStage(id, 'billing', SAM);
        await service.staffChangeStage(id, 'done', SAM);

        const stages = service.audit(50)
            .filter(e => e.kind === 'stage')
            .map(e => [ e.issuer, e.encounterId, e.from, e.to, e.outcome ].join('|'));

        assert.deepEqual(stages.sort(), [
            `s-1|${id}|billing|done|refused`,
            `s-1|${id}|waiting|billing|ok`
        ]);
    });

    it('says where a staff member is and, in a patient\'s room, the stage and the stages to pick', async () => {
        const id = await samInPatientsRoom();
        const context = await service.staffContext(SAM);

        assert.equal(context.where, 'patients_room');
        assert.equal(context.encounter?.id, id);
        assert.equal(context.encounter?.stage, 'waiting');
        assert.ok(!context.stages?.some(s => s.id === 'done'));
        assert.ok(context.stages?.some(s => s.id === 'billing'));

        rooms = [ { name: 'lounge-intake', occupants: [ staffAt('s-1', 'e-sam') ] } ];
        assert.equal((await service.staffContext(SAM)).where, 'lounge');
        rooms = [];
        assert.equal((await service.staffContext(SAM)).where, 'nowhere');
    });
});
