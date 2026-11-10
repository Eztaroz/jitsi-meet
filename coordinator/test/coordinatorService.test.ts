import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MockTimersOptions, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { ARRIVAL_WAIT_MS, COUNTDOWN_MS } from '../src/rules.ts';
import { Store } from '../src/store.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const APIS: MockTimersOptions['apis'] = [ 'Date', 'setInterval', 'setTimeout' ];
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const staff = { endpointId: 'e-staff', hidden: false, identity: { user: { hospital_role: 'staff', id: 's-1', name: 'Sam' } } };
const patient = { endpointId: 'e-pat', hidden: false, identity: { user: { hospital_role: 'patient', id: 'p-1', name: 'Pat' } } };

/**
 * Lets the promises that are ready run, without waiting on any clock.
 *
 * @returns {Promise<void>}
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await nextTurn();
    }
}

/**
 * Moves the mock clock on, then lets the work it started run.
 *
 * @param {number} ms - How far.
 * @returns {Promise<void>}
 */
async function advance(ms: number): Promise<void> {
    mock.timers.tick(ms);
    await settle();
}

describe('the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let sent: { endpointId: string; room: string; }[];
    let recorded: string[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        mock.timers.enable({ apis: APIS, now: T0 });
        rooms = [];
        sent = [];
        recorded = [];
        store = new Store(mkdtempSync(join(tmpdir(), 'service-')));
        service = makeService();
    });

    /**
     * Creates the service over the fakes.
     *
     * @returns {CoordinatorService}
     */
    function makeService(): CoordinatorService {
        return new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [ { id: 'center-1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ] } ] },
            prosody: {
                rooms: async () => ({ rooms }),
                sendMove: async ({ endpointId, room }: { endpointId: string; room: string; }) => {
                    sent.push({ endpointId, room });
                }
            } as unknown as Prosody,
            recorderBot: {
                recordRoom: async (hn: string) => {
                    recorded.push(hn);

                    return 'c-1';
                },
            } as unknown as RecorderBot,
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

    afterEach(() => {
        service.stop();
        store.close();
        mock.timers.reset();
    });

    const stateOf = (moveId: string) => service.state.moves.find(m => m.id === moveId);

    it('sends a participant to an open room and fails the move when they do not arrive in time', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        assert.equal(move.state, 'counting_down');
        assert.deepEqual(sent, [ { endpointId: 'e-staff', room: 'a' } ]);

        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS - 1);
        assert.equal(stateOf(move.id)?.state, 'counting_down');

        await advance(1);
        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'participant_did_not_arrive');
    });

    it('notices the arrival by polling the rooms while the move is under way', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        rooms = [ { name: 'a', occupants: [] }, { name: 'b', occupants: [ patient, staff ] } ];
        await advance(1000);

        assert.equal(stateOf(move.id)?.state, 'done');
    });

    it('refuses to move a patient, says why, sends nothing and asks the recorder bot nothing', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient ] }, { name: 'lounge-intake', occupants: [ staff ] } ];

        const move = await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'lounge-intake' }, 'system');

        await settle();
        assert.equal(move.state, 'refused');
        assert.equal(move.reason, 'patients_never_move');
        assert.deepEqual(sent, []);
        assert.deepEqual(recorded, []);
    });

    it('audits the refused patient move with its reason, without the HN', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient ] }, { name: 'hn-b', occupants: [] } ];

        await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'hn-b' }, 'coordinator-7');

        const entry = service.audit(10).find(e => e.kind === 'move');

        assert.equal(entry?.outcome, 'refused');
        assert.equal(entry?.reason, 'patients_never_move');
        assert.equal(entry?.issuer, 'coordinator-7');
        assert.doesNotMatch(JSON.stringify(entry), /hn-/u);
    });

    it('moves a staff member back into their lounge while nobody is in it', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient, staff ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'hn-a', toRoom: 'lounge-intake' }, 'system');

        assert.equal(move.state, 'counting_down');
        assert.deepEqual(sent, [ { endpointId: 'e-staff', room: 'hn-a' } ]);
        assert.deepEqual(recorded, []);
    });

    it('refuses to move a staff member into a patient\'s room that is closed', async () => {
        rooms = [ { name: 'lounge-intake', occupants: [ staff ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'lounge-intake', toRoom: 'hn-z' }, 'system');

        assert.equal(move.reason, 'destination_not_open');
        assert.deepEqual(sent, []);
    });

    it('reports each staff member\'s station: in its lounge, and in a patient\'s room once seen in the lounge', async () => {
        rooms = [ { name: 'lounge-intake', occupants: [ staff ] }, { name: 'hn-a', occupants: [ patient ] } ];

        const inLounge = await service.rooms();

        assert.equal(inLounge.find(r => r.name === 'lounge-intake')?.occupants[0].station, 'intake');

        rooms = [ { name: 'hn-a', occupants: [ patient, staff ] } ];

        const visiting = (await service.rooms()).find(r => r.name === 'hn-a')?.occupants;

        assert.equal(visiting?.find(o => o.endpointId === 'e-staff')?.station, 'intake');
        assert.equal(visiting?.find(o => o.endpointId === 'e-pat')?.station, undefined);
    });

    it('reports no station for a staff member it has never seen in a lounge', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient, staff ] } ];

        const occupants = (await service.rooms()).flatMap(r => r.occupants);

        assert.equal(occupants.find(o => o.endpointId === 'e-staff')?.station, undefined);
    });

    it('keeps the staff\'s stations over a restart', async () => {
        rooms = [ { name: 'lounge-intake', occupants: [ staff ] } ];
        await service.rooms();
        await settle();
        service.stop();
        service = makeService();
        rooms = [ { name: 'hn-a', occupants: [ patient, staff ] } ];

        const occupants = (await service.rooms()).flatMap(r => r.occupants);

        assert.equal(occupants.find(o => o.endpointId === 'e-staff')?.station, 'intake');
    });


    it('closes the day\'s open encounters at the next midnight', async () => {
        await service.startEncounter('HN1');
        service.startDayEnds();

        await advance(15 * 3600_000 + 59 * 60_000);
        assert.equal(service.state.encounters[0].stage, 'waiting');

        await advance(60_000);
        assert.equal(service.state.encounters[0].stage, 'done');
        assert.equal(service.state.encounters[0].unfinished, true);
    });
});
