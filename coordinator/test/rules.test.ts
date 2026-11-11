import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARRIVAL_WAIT_MS, COUNTDOWN_MS, type IState, initialState, step } from '../src/rules.ts';

const T0 = new Date('2030-01-01T08:00:00Z');

describe('starting an encounter', () => {
    it('opens an encounter in the waiting stage and asks the recorder bot to record the patient\'s room', () => {
        const { commands, encounter, state } = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });

        assert.equal(encounter?.stage, 'waiting');
        assert.equal(encounter?.hn, 'TEST-1');
        assert.equal(encounter?.created, true);
        assert.deepEqual(commands, [ { encounterId: encounter?.id, hn: 'TEST-1', type: 'record_room' } ]);
        assert.equal(state.encounters.length, 1);
    });

    it('returns the open encounter for an HN that already has one, and asks the recorder bot nothing new', () => {
        const first = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });
        const again = step(first.state, { at: new Date(T0.getTime() + 1000), hn: 'TEST-1', type: 'start_encounter' });

        assert.equal(again.encounter?.id, first.encounter?.id);
        assert.equal(again.encounter?.created, false);
        assert.deepEqual(again.commands, []);
        assert.equal(again.state.encounters.length, 1);
    });

    it('gives each HN its own encounter with its own opaque id', () => {
        const a = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });
        const b = step(a.state, { at: T0, hn: 'TEST-2', type: 'start_encounter' });

        assert.notEqual(a.encounter?.id, b.encounter?.id);
        assert.doesNotMatch(String(a.encounter?.id), /TEST/u);
        assert.equal(b.state.encounters.length, 2);
    });
});

describe('moving a staff member', () => {
    const room = (name: string, ...occupants: [ string, string, 'patient' | 'staff' | 'hidden' ][]) => ({
        name,
        occupants: occupants.map(([ endpointId, id, role ]) => {
            return { endpointId, identity: role === 'hidden' ? undefined : { id }, role };
        })
    });
    const lounge = room('lounge-1', [ 'e-doc', 'doc-1', 'staff' ]);
    const patientRoom = room('patient-a', [ 'e-pat', 'pat-1', 'patient' ]);
    const request = (rooms = [ lounge, patientRoom ], over = {}) => ({
        at: T0,
        endpointId: 'e-doc',
        fromRoom: 'lounge-1',
        rooms,
        toRoom: 'patient-a',
        type: 'request_move' as const,
        ...over
    });

    it('sends the move to the participant and waits for them to arrive, within the countdown and the arrival wait', () => {
        const { commands, move, state } = step(initialState(), request());

        assert.equal(move?.state, 'counting_down');
        assert.deepEqual(commands.map(c => c.type), [ 'send_move', 'start_timer' ]);
        assert.deepEqual(commands[0], {
            destination: 'patient-a', endpointId: 'e-doc', moveId: move?.id, room: 'lounge-1', type: 'send_move'
        });
        assert.deepEqual(commands[1], {
            afterMs: COUNTDOWN_MS + ARRIVAL_WAIT_MS, moveId: move?.id, timer: 'move_arrival', type: 'start_timer'
        });
        assert.equal(state.moves.length, 1);
    });

    it('is done once the same verified identity is in the destination', () => {
        const started = step(initialState(), request());
        const arrived = room('patient-a', [ 'e-pat', 'pat-1', 'patient' ], [ 'e-doc2', 'doc-1', 'staff' ]);
        const done = step(started.state, { at: new Date(T0.getTime() + 8000), rooms: [ arrived ], type: 'rooms_snapshot' });

        assert.equal(done.state.moves[0].state, 'done');
        assert.deepEqual(done.commands, []);
    });

    it('stays counting down while they have not arrived', () => {
        const started = step(initialState(), request());
        const later = step(started.state, { at: new Date(T0.getTime() + 8000), rooms: [ patientRoom ], type: 'rooms_snapshot' });

        assert.equal(later.state.moves[0].state, 'counting_down');
    });

    it('fails with a reason when they do not arrive in time', () => {
        const started = step(initialState(), request());
        const failed = step(started.state, {
            at: new Date(T0.getTime() + COUNTDOWN_MS + ARRIVAL_WAIT_MS), moveId: started.move?.id as string,
            timer: 'move_arrival', type: 'timer_fired'
        });

        assert.equal(failed.state.moves[0].state, 'failed');
        assert.equal(failed.state.moves[0].reason, 'participant_did_not_arrive');
    });

    it('ignores the timer of a move that is already done', () => {
        const started = step(initialState(), request());
        const arrived = room('patient-a', [ 'e-doc2', 'doc-1', 'staff' ]);
        const done = step(started.state, { at: T0, rooms: [ arrived ], type: 'rooms_snapshot' });
        const late = step(done.state, { at: T0, moveId: started.move?.id as string, timer: 'move_arrival', type: 'timer_fired' });

        assert.equal(late.state.moves[0].state, 'done');
    });

    it('refuses a participant who is not in the room, with a reason, and sends nothing', () => {
        const { commands, move } = step(initialState(), request(undefined, { endpointId: 'nobody' }));

        assert.equal(move?.state, 'refused');
        assert.equal(move?.reason, 'participant_not_found');
        assert.deepEqual(commands, []);
    });

    it('refuses a destination that is not open', () => {
        const { move } = step(initialState(), request(undefined, { toRoom: 'closed-room' }));

        assert.equal(move?.state, 'refused');
        assert.equal(move?.reason, 'destination_not_open');
    });

    it('refuses to move the hidden recorder bot', () => {
        const withBot = room('lounge-1', [ 'e-bot', '', 'hidden' ]);
        const { move } = step(initialState(), request([ withBot, patientRoom ], { endpointId: 'e-bot' }));

        assert.equal(move?.reason, 'participant_not_movable');
    });

    it('is cancelled when the moved participant says so, and stays where they are', () => {
        const started = step(initialState(), request());
        const moveId = started.move?.id as string;
        const cancelling = { ...lounge, occupants: [ { ...lounge.occupants[0], cancelledMove: moveId } ] };
        const cancelled = step(started.state, { at: T0, rooms: [ cancelling, patientRoom ], type: 'rooms_snapshot' });

        assert.equal(cancelled.state.moves[0].state, 'cancelled');
    });

    it('ignores a cancellation that names another move', () => {
        const started = step(initialState(), request());
        const cancelling = { ...lounge, occupants: [ { ...lounge.occupants[0], cancelledMove: 'some-other-move' } ] };
        const same = step(started.state, { at: T0, rooms: [ cancelling, patientRoom ], type: 'rooms_snapshot' });

        assert.equal(same.state.moves[0].state, 'counting_down');
    });

    it('ignores the timer of a cancelled move', () => {
        const started = step(initialState(), request());
        const moveId = started.move?.id as string;
        const cancelling = { ...lounge, occupants: [ { ...lounge.occupants[0], cancelledMove: moveId } ] };
        const cancelled = step(started.state, { at: T0, rooms: [ cancelling, patientRoom ], type: 'rooms_snapshot' });
        const late = step(cancelled.state, { at: T0, moveId, timer: 'move_arrival', type: 'timer_fired' });

        assert.equal(late.state.moves[0].state, 'cancelled');
    });

    it('refuses a second move of someone whose move is still under way, and leaves the first alone', () => {
        const first = step(initialState(), request());
        const second = step(first.state, request());

        assert.equal(second.move?.state, 'refused');
        assert.equal(second.move?.reason, 'already_being_moved');
        assert.deepEqual(second.commands, []);
        assert.equal(second.state.moves.find(m => m.id === first.move?.id)?.state, 'counting_down');
    });

    it('accepts a new move of someone whose earlier move is over', () => {
        const first = step(initialState(), request());
        const cancelling = { ...lounge, occupants: [ { ...lounge.occupants[0], cancelledMove: first.move?.id } ] };
        const cancelled = step(first.state, { at: T0, rooms: [ cancelling, patientRoom ], type: 'rooms_snapshot' });
        const again = step(cancelled.state, request());

        assert.equal(again.move?.state, 'counting_down');
    });

});

describe('a patient', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const here = { kind: 'patient' as const, name: 'patient-a', occupants: [ occupant('e-pat', 'pat-1', 'patient') ] };
    const lounge = {
        kind: 'lounge' as const, name: 'lounge-intake', occupants: [ occupant('e-nurse', 'n-1', 'staff') ], station: 'intake'
    };
    const other = { kind: 'patient' as const, name: 'patient-b', occupants: [ occupant('e-pat2', 'pat-2', 'patient') ] };
    const request = (toRoom: string) => ({
        at: T0,
        endpointId: 'e-pat',
        fromRoom: 'patient-a',
        rooms: [ here, lounge, other ],
        toRoom,
        type: 'request_move' as const
    });

    it('is never moved, wherever to: the move is refused with its reason and nothing is sent', () => {
        for (const toRoom of [ 'lounge-intake', 'patient-b', 'patient-c' ]) {
            const { commands, move, state } = step(initialState(), request(toRoom));

            assert.equal(move?.state, 'refused', toRoom);
            assert.equal(move?.reason, 'patients_never_move', toRoom);
            assert.deepEqual(commands, [], toRoom);
            assert.equal(state.moves[0].reason, 'patients_never_move', toRoom);
        }
    });

    it('still has their own room learned, for the surveys', () => {
        const { state } = step(initialState(), request('lounge-intake'));

        assert.deepEqual(state.patientRooms, { 'pat-1': 'patient-a', 'pat-2': 'patient-b' });
    });
});

describe('a staff member\'s station', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const lounge = (name: string, station: string, ...occupants: ReturnType<typeof occupant>[]) => {
        return { kind: 'lounge' as const, name, occupants, station };
    };
    const patientRoom = { kind: 'patient' as const, name: 'patient-a', occupants: [ occupant('e-pat', 'pat-1', 'patient') ] };

    it('is learned from the lounge they are seen in', () => {
        const { state } = step(initialState(), {
            at: T0, rooms: [ lounge('lounge-intake', 'intake', occupant('e-nurse', 'n-1', 'staff')) ], type: 'rooms_snapshot'
        });

        assert.deepEqual(state.staffStations, { 'n-1': 'intake' });
    });

    it('stays while they are in a patient\'s room, and changes when they are seen in another lounge', () => {
        const seen = step(initialState(), {
            at: T0, rooms: [ lounge('lounge-intake', 'intake', occupant('e-nurse', 'n-1', 'staff')) ], type: 'rooms_snapshot'
        });
        const visiting = step(seen.state, {
            at: T0,
            rooms: [ { ...patientRoom, occupants: [ ...patientRoom.occupants, occupant('e-nurse2', 'n-1', 'staff') ] } ],
            type: 'rooms_snapshot'
        });
        const changed = step(visiting.state, {
            at: T0, rooms: [ lounge('lounge-aftercare', 'aftercare', occupant('e-nurse3', 'n-1', 'staff')) ], type: 'rooms_snapshot'
        });

        assert.equal(visiting.state.staffStations['n-1'], 'intake');
        assert.equal(changed.state.staffStations['n-1'], 'aftercare');
    });

    it('is not learned for a patient, nor from a patient\'s room', () => {
        const { state } = step(initialState(), {
            at: T0,
            rooms: [
                lounge('lounge-intake', 'intake', occupant('e-pat', 'pat-1', 'patient')),
                { ...patientRoom, occupants: [ occupant('e-doc', 'd-1', 'staff') ] }
            ],
            type: 'rooms_snapshot'
        });

        assert.deepEqual(state.staffStations, {});
    });

    it('leaves the state as it was when nothing is new', () => {
        const rooms = [ lounge('lounge-intake', 'intake', occupant('e-nurse', 'n-1', 'staff')) ];
        const seen = step(initialState(), { at: T0, rooms, type: 'rooms_snapshot' });
        const again = step(seen.state, { at: T0, rooms, type: 'rooms_snapshot' });

        assert.equal(again.state, seen.state);
    });
});

describe('moving a staff member between lounges and patients\' rooms', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const nurse = occupant('e-nurse', 'n-1', 'staff');
    const patientRoom = { kind: 'patient' as const, name: 'patient-a', occupants: [ occupant('e-pat', 'pat-1', 'patient'), nurse ] };
    const closedLounge = { kind: 'lounge' as const, name: 'lounge-intake', occupants: [], open: false, station: 'intake' };
    const move = (rooms: unknown[], toRoom: string) => step(initialState(), {
        at: T0, endpointId: 'e-nurse', fromRoom: 'patient-a', rooms: rooms as never, toRoom, type: 'request_move'
    });

    it('may go back to a lounge nobody is in', () => {
        const { commands, move: moved } = move([ patientRoom, closedLounge ], 'lounge-intake');

        assert.equal(moved?.state, 'counting_down');
        assert.deepEqual(commands.map(c => c.type), [ 'send_move', 'start_timer' ]);
    });

    it('is refused a patient\'s room that is closed', () => {
        const closed = { kind: 'patient' as const, name: 'patient-b', occupants: [], open: false };
        const { commands, move: refused } = move([ patientRoom, closed ], 'patient-b');

        assert.equal(refused?.reason, 'destination_not_open');
        assert.deepEqual(commands, []);
    });

    it('may go into another patient\'s open room', () => {
        const other = { kind: 'patient' as const, name: 'patient-b', occupants: [ occupant('e-pat2', 'pat-2', 'patient') ] };

        assert.equal(move([ patientRoom, other ], 'patient-b').move?.state, 'counting_down');
    });
});

describe('a move that cannot go on', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const lounge = { kind: 'lounge' as const, name: 'lounge-intake', occupants: [ occupant('e-nurse', 'n-1', 'staff') ], station: 'intake' };
    const patientRoom = { kind: 'patient' as const, name: 'patient-a', occupants: [ occupant('e-pat', 'pat-1', 'patient') ] };

    it('fails with its reason when its command could not be sent', () => {
        const started = step(initialState(), {
            at: T0, endpointId: 'e-nurse', fromRoom: 'lounge-intake', rooms: [ lounge, patientRoom ], toRoom: 'patient-a',
            type: 'request_move'
        });
        const failed = step(started.state, {
            at: T0, moveId: started.move?.id as string, reason: 'could_not_send_move', type: 'move_failed'
        });

        assert.equal(failed.state.moves[0].state, 'failed');
        assert.equal(failed.state.moves[0].reason, 'could_not_send_move');
        assert.deepEqual(failed.commands, []);
    });

    it('fails a move left preparing from when patients were moved', () => {
        const legacy: IState = {
            ...initialState(),
            moves: [ {
                destination: 'intake-1', endpointId: 'e-pat', id: 'm-1', identityId: 'pat-1', origin: 'patient-a',
                startedAt: T0, state: 'preparing'
            } ]
        };
        const failed = step(legacy, { at: T0, moveId: 'm-1', reason: 'patient_moves_retired', type: 'move_failed' });

        assert.equal(failed.state.moves[0].state, 'failed');
        assert.equal(failed.state.moves[0].reason, 'patient_moves_retired');
    });

    it('leaves a move that has ended as it was', () => {
        const legacy: IState = {
            ...initialState(),
            moves: [ { destination: 'x', endpointId: 'e', id: 'm-1', origin: 'y', startedAt: T0, state: 'done' } ]
        };
        const same = step(legacy, { at: T0, moveId: 'm-1', reason: 'could_not_send_move', type: 'move_failed' });

        assert.equal(same.state, legacy);
    });
});
