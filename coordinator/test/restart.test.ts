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
import { ARRIVAL_WAIT_MS, COUNTDOWN_MS, type IMove, PREPARE_WAIT_MS } from '../src/rules.ts';
import { Store } from '../src/store.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const APIS: MockTimersOptions['apis'] = [ 'Date', 'setInterval', 'setTimeout' ];
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const user = (role: string, id: string) => ({ hospital_role: role, id, name: id });
const staff = { endpointId: 'e-staff', hidden: false, identity: { user: user('staff', 's-1') } };
const patient = { endpointId: 'e-pat', hidden: false, identity: { user: user('patient', 'p-1') } };

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

describe('the coordinator service across a restart', () => {
    let dir: string;
    let rooms: { name: string; occupants: unknown[]; }[];
    let sent: { endpointId: string; room: string; }[];
    let recorded: string[];
    let stopped: string[];
    let botStatus: string;
    let service: CoordinatorService;
    let store: Store;

    /**
     * Starts a service on the store in the directory, as the process does.
     *
     * @returns {CoordinatorService}
     */
    function boot(): CoordinatorService {
        store = new Store(dir);

        return new CoordinatorService({
            auditKey: 'audit-key',
            layout: { lounges: [], stations: [ { room: 'station-1', stage: 'intake' } ] },
            prosody: {
                rooms: async () => ({ rooms }),
                sendMove: async ({ endpointId, room }: { endpointId: string; room: string; }) => {
                    sent.push({ endpointId, room });
                }
            } as unknown as Prosody,
            recorderBot: {
                recordRoom: async (hn: string, station?: unknown) => {
                    recorded.push(station ? `${hn}@station` : hn);

                    return `c-${recorded.length}`;
                },
                status: async () => botStatus,
                stop: async (id: string) => {
                    stopped.push(id);
                }
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

    /**
     * Stops the service while time goes on, then starts a new one on the same store.
     *
     * @param {number} downMs - How long the service is down.
     * @returns {Promise<void>}
     */
    async function restart(downMs = 0): Promise<void> {
        service.stop();
        store.close();
        mock.timers.tick(downMs);
        service = boot();
        await service.resume();
        await settle();
    }

    beforeEach(() => {
        mock.timers.enable({ apis: APIS, now: T0 });
        dir = mkdtempSync(join(tmpdir(), 'restart-'));
        rooms = [];
        sent = [];
        recorded = [];
        stopped = [];
        botStatus = 'starting';
        service = boot();
    });

    afterEach(() => {
        service.stop();
        store.close();
        mock.timers.reset();
    });

    /**
     * Learns the patient's own room, then asks to move them back into it while it is closed: the move prepares it.
     *
     * @returns {Promise<IMove>}
     */
    async function moveToClosedOwnRoom(): Promise<IMove> {
        rooms = [ { name: 'hn-a', occupants: [ patient ] }, { name: 'station-1', occupants: [ staff ] } ];
        await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'station-1' }, 'system');
        await advance(PREPARE_WAIT_MS);
        rooms = [ { name: 'station-1', occupants: [ staff, patient ] } ];

        return service.requestMove({ endpointId: 'e-pat', fromRoom: 'station-1', toRoom: 'hn-a' }, 'system');
    }

    const stateOf = (moveId: string) => service.state.moves.find(m => m.id === moveId);
    const moveAudits = () => service.audit(100).filter(e => e.kind === 'move');

    it('completes a move that was counting down when the arrival comes after the restart', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        await advance(10_000);
        await restart();
        assert.equal(stateOf(move.id)?.state, 'counting_down');

        rooms = [ { name: 'a', occupants: [] }, { name: 'b', occupants: [ patient, staff ] } ];
        await advance(1000);

        assert.equal(stateOf(move.id)?.state, 'done');
        assert.equal(moveAudits().length, 1);
    });

    it('still times out a counting-down move at its original deadline after the restart', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        await advance(10_000);
        await restart();

        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS - 10_000 - 1);
        assert.equal(stateOf(move.id)?.state, 'counting_down');

        await advance(1);
        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'participant_did_not_arrive');
    });

    it('fails a move whose arrival deadline passed during the restart as soon as the service is back, audited once', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'coord-1');

        await restart(COUNTDOWN_MS + ARRIVAL_WAIT_MS + 60_000);

        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'participant_did_not_arrive');
        assert.equal(moveAudits().length, 1);
        assert.equal(moveAudits()[0].issuer, 'coord-1');
        assert.equal(moveAudits()[0].outcome, 'failed');

        await restart();
        assert.equal(moveAudits().length, 1);
    });

    it('stops and discards the station consultation of a patient who never came, even across a restart', async () => {
        rooms = [
            { name: 'hn-a', occupants: [ patient ] },
            { name: 'station-1', occupants: [ staff ] }
        ];

        const move = await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'station-1' }, 'system');

        await settle();
        botStatus = 'waiting_for_participants';
        await advance(500);
        assert.equal(stateOf(move.id)?.state, 'counting_down');
        assert.deepEqual(recorded, [ 'hn-a@station' ]);

        await restart(COUNTDOWN_MS + ARRIVAL_WAIT_MS + 1000);

        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.deepEqual(stopped, [ 'c-1' ]);
    });

    it('fails a move still waiting for the recorder bot with recorder_bot_not_ready when its deadline passed', async () => {
        const move = await moveToClosedOwnRoom();

        await settle();
        await restart(PREPARE_WAIT_MS + 1000);

        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'recorder_bot_not_ready');
        // One entry for the earlier station move that failed, one for this move.
        assert.equal(moveAudits().length, 2);
        assert.equal(moveAudits()[0].reason, 'recorder_bot_not_ready');
        assert.deepEqual(sent, []);
    });

    it('resumes the wait for the recorder bot for the time left, then sends the patient', async () => {
        const move = await moveToClosedOwnRoom();

        await advance(10_000);
        await restart();
        assert.equal(stateOf(move.id)?.state, 'preparing');

        botStatus = 'recording';
        await advance(500);
        assert.equal(stateOf(move.id)?.state, 'counting_down');
        assert.equal(sent.length, 1);
    });

    it('fails a resumed wait at its original deadline when the recorder bot never comes', async () => {
        const move = await moveToClosedOwnRoom();

        await advance(10_000);
        await restart();
        await advance(PREPARE_WAIT_MS - 10_000 - 1);
        assert.equal(stateOf(move.id)?.state, 'preparing');

        await advance(1);
        assert.equal(stateOf(move.id)?.reason, 'recorder_bot_not_ready');
    });

    it('lets a patient be moved back into their own room after a restart without being seen again', async () => {
        rooms = [
            { name: 'hn-a', occupants: [ patient ] },
            { name: 'station-1', occupants: [ staff ] }
        ];
        await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'station-1' }, 'system');
        await advance(PREPARE_WAIT_MS);
        await restart();

        rooms = [
            { name: 'hn-a', occupants: [ staff ] },
            { name: 'station-1', occupants: [ patient ] }
        ];

        const back = await service.requestMove({ endpointId: 'e-pat', fromRoom: 'station-1', toRoom: 'hn-a' }, 'system');

        assert.equal(back.reason, undefined);
        assert.notEqual(back.state, 'refused');
    });

    it('does not audit a move that ended before the restart a second time', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];
        await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');
        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS);
        assert.equal(moveAudits().length, 1);

        await restart();
        await restart();

        assert.equal(moveAudits().length, 1);
    });

    it('deletes stored moves and patients\' own rooms in the retention sweep', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'hn-a', occupants: [ patient ] } ];
        await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'hn-a' }, 'system');
        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS);
        await restart();
        assert.equal(service.state.moves.length, 1);
        assert.deepEqual(service.state.patientRooms, { 'p-1': 'hn-a' });

        mock.timers.tick(91 * 24 * 3600_000);
        service.startRetention();
        await settle();
        await restart();

        assert.equal(service.state.moves.length, 0);
        assert.deepEqual(service.state.patientRooms, {});
    });

    it('forgets the patients\' own rooms when the day closes, also across a restart', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'hn-a', occupants: [ patient ] } ];
        await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'hn-a' }, 'system');
        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS);
        service.startDayEnds();
        await advance(16 * 3600_000 + 60_000);

        assert.deepEqual(service.state.patientRooms, {});
        await restart();
        assert.deepEqual(service.state.patientRooms, {});
    });
});
