import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARRIVAL_WAIT_MS, COUNTDOWN_MS, PREPARE_WAIT_MS, initialState, step } from '../src/rules.ts';

const T0 = new Date('2030-01-01T08:00:00Z');

describe('starting an encounter', () => {
    it('opens an encounter in the waiting stage and asks the recorder bot to record the patient\'s room', () => {
        const { commands, encounter, state } = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });

        assert.equal(encounter?.stage, 'waiting');
        assert.equal(encounter?.hn, 'TEST-1');
        assert.equal(encounter?.created, true);
        assert.deepEqual(commands, [ { hn: 'TEST-1', type: 'record_room' } ]);
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

describe('moving a patient', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const here = { name: 'patient-a', occupants: [ occupant('e-pat', 'pat-1', 'patient') ] };
    const station = { kind: 'station' as const, name: 'intake-1', occupants: [ occupant('e-nurse', 'n-1', 'staff') ] };
    const lounge = { kind: 'lounge' as const, name: 'lounge-1', occupants: [ occupant('e-doc', 'd-1', 'staff') ] };
    const other = { name: 'patient-b', occupants: [ occupant('e-pat2', 'pat-2', 'patient') ] };
    const request = (rooms: unknown[], toRoom: string) => ({
        at: T0,
        endpointId: 'e-pat',
        fromRoom: 'patient-a',
        rooms: rooms as never,
        toRoom,
        type: 'request_move' as const
    });

    it('is refused a room that holds another patient', () => {
        const { commands, move } = step(initialState(), request([ here, other ], 'patient-b'));

        assert.equal(move?.state, 'refused');
        assert.equal(move?.reason, 'destination_holds_a_patient');
        assert.deepEqual(commands, []);
    });

    it('is refused a lounge, open or closed', () => {
        const open = step(initialState(), request([ here, lounge ], 'lounge-1'));
        const closed = step(initialState(), request([ here, { ...lounge, occupants: [], open: false } ], 'lounge-1'));

        assert.equal(open.move?.reason, 'patient_into_lounge');
        assert.equal(closed.move?.reason, 'patient_into_lounge');
    });

    it('may go back to their own room while it is closed: the recorder bot is asked first, and nothing is sent yet', () => {
        const { commands, move } = step(initialState(), request([ here ], 'home-room'));

        assert.equal(move?.state, 'preparing');
        assert.deepEqual(commands, [
            { hn: 'home-room', moveId: move?.id, type: 'prepare_destination' },
            { afterMs: PREPARE_WAIT_MS, moveId: move?.id, timer: 'move_prepare', type: 'start_timer' }
        ]);
    });

    it('is sent, and waits for the arrival, once the recorder bot is in the destination', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });

        assert.equal(ready.state.moves[0].state, 'counting_down');
        assert.deepEqual(ready.commands.map(c => c.type), [ 'send_move', 'start_timer' ]);
    });

    it('fails, with its reason, when the recorder bot is at capacity, and nothing is sent', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const failed = step(preparing.state, {
            at: T0, moveId: preparing.move?.id as string, reason: 'recorder_bot_at_capacity', type: 'destination_failed'
        });

        assert.equal(failed.state.moves[0].state, 'failed');
        assert.equal(failed.state.moves[0].reason, 'recorder_bot_at_capacity');
        assert.deepEqual(failed.commands, []);
    });

    it('fails when the recorder bot is not ready in time', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const failed = step(preparing.state, {
            at: new Date(T0.getTime() + PREPARE_WAIT_MS), moveId: preparing.move?.id as string,
            timer: 'move_prepare', type: 'timer_fired'
        });

        assert.equal(failed.state.moves[0].state, 'failed');
        assert.equal(failed.state.moves[0].reason, 'recorder_bot_not_ready');
    });

    it('ignores the preparation timer once the move is sent', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });
        const late = step(ready.state, { at: T0, moveId: preparing.move?.id as string, timer: 'move_prepare', type: 'timer_fired' });

        assert.equal(late.state.moves[0].state, 'counting_down');
    });

    it('is refused a closed station, for now', () => {
        const closed = { ...station, occupants: [], open: false };
        const { move } = step(initialState(), request([ here, closed ], 'intake-1'));

        assert.equal(move?.reason, 'destination_not_open');
    });

    it('does not make a second move while one is being prepared', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const second = step(preparing.state, request([ here ], 'home-room'));

        assert.equal(second.move?.reason, 'already_being_moved');
    });

    it('a staff member is still refused a closed room', () => {
        const staffInLounge = { kind: 'lounge' as const, name: 'lounge-1', occupants: [ occupant('e-doc', 'd-1', 'staff') ] };
        const { move } = step(initialState(), {
            at: T0, endpointId: 'e-doc', fromRoom: 'lounge-1', rooms: [ staffInLounge ] as never, toRoom: 'closed', type: 'request_move'
        });

        assert.equal(move?.reason, 'destination_not_open');
    });

    it('fails a move that could not be sent, whichever way it was waiting', () => {
        const preparing = step(initialState(), request([ here ], 'home-room'));
        const sentFail = step(preparing.state, {
            at: T0, moveId: preparing.move?.id as string, reason: 'could_not_send_move', type: 'destination_failed'
        });

        assert.equal(sentFail.state.moves[0].reason, 'could_not_send_move');
        assert.equal(sentFail.state.moves[0].state, 'failed');

        const counting = step(initialState(), request([ here, station ], 'intake-1'));
        const failed = step(counting.state, {
            at: T0, moveId: counting.move?.id as string, reason: 'could_not_send_move', type: 'destination_failed'
        });

        assert.equal(failed.state.moves[0].state, 'failed');
    });

});

describe('moving a patient into a station', () => {
    const occupant = (endpointId: string, id: string, role: 'patient' | 'staff') => ({ endpointId, identity: { id }, role });
    const home = { kind: 'patient' as const, name: 'home-1', occupants: [ occupant('e-pat', 'pat-1', 'patient') ] };
    const station = { kind: 'station' as const, name: 'intake-1', occupants: [ occupant('e-nurse', 'n-1', 'staff') ] };
    const station2 = { kind: 'station' as const, name: 'aftercare-1', occupants: [ occupant('e-nurse2', 'n-2', 'staff') ] };
    const request = (rooms: unknown[], over = {}) => ({
        at: T0,
        endpointId: 'e-pat',
        fromRoom: 'home-1',
        rooms: rooms as never,
        toRoom: 'intake-1',
        type: 'request_move' as const,
        ...over
    });

    it('asks the recorder bot to record the patient in the station first, under their HN, and sends nothing yet', () => {
        const { commands, move } = step(initialState(), request([ home, station ]));

        assert.equal(move?.state, 'preparing');
        assert.deepEqual(commands, [
            {
                hn: 'home-1', moveId: move?.id, station: { patientId: 'pat-1', room: 'intake-1' }, type: 'prepare_destination'
            },
            { afterMs: PREPARE_WAIT_MS, moveId: move?.id, timer: 'move_prepare', type: 'start_timer' }
        ]);
    });

    it('is sent once the recorder bot is in the station', () => {
        const preparing = step(initialState(), request([ home, station ]));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });

        assert.deepEqual(ready.commands.map(c => c.type), [ 'send_move', 'start_timer' ]);
    });

    it('knows the HN of a patient who is in a station, from where it saw them before', () => {
        const seen = step(initialState(), { at: T0, rooms: [ home, station ] as never, type: 'rooms_snapshot' });
        const inStation = { ...station, occupants: [ ...station.occupants, occupant('e-pat3', 'pat-1', 'patient') ] };
        const { commands, move } = step(seen.state, request(
            [ { ...home, occupants: [] }, inStation, station2 ],
            { endpointId: 'e-pat3', fromRoom: 'intake-1', toRoom: 'aftercare-1' }));

        assert.equal(move?.state, 'preparing');
        assert.deepEqual(commands[0], {
            hn: 'home-1', moveId: move?.id, station: { patientId: 'pat-1', room: 'aftercare-1' }, type: 'prepare_destination'
        });
    });

    it('refuses a patient whose room is not known', () => {
        const inStation = { ...station, occupants: [ ...station.occupants, occupant('e-pat3', 'pat-1', 'patient') ] };
        const { commands, move } = step(initialState(), request(
            [ inStation, station2 ], { endpointId: 'e-pat3', fromRoom: 'intake-1', toRoom: 'aftercare-1' }));

        assert.equal(move?.reason, 'patient_room_unknown');
        assert.deepEqual(commands, []);
    });

    it('stops the station consultation when the patient cancels', () => {
        const preparing = step(initialState(), request([ home, station ]));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });
        const cancelling = { ...home, occupants: [ { ...home.occupants[0], cancelledMove: preparing.move?.id } ] };
        const cancelled = step(ready.state, { at: T0, rooms: [ cancelling, station ] as never, type: 'rooms_snapshot' });

        assert.equal(cancelled.state.moves[0].state, 'cancelled');
        assert.deepEqual(cancelled.commands, [ { moveId: preparing.move?.id, type: 'stop_station_consultation' } ]);
    });

    it('stops it when the patient does not arrive, and when the move could not be sent', () => {
        const preparing = step(initialState(), request([ home, station ]));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });
        const late = step(ready.state, { at: T0, moveId: preparing.move?.id as string, timer: 'move_arrival', type: 'timer_fired' });
        const unsent = step(ready.state, {
            at: T0, moveId: preparing.move?.id as string, reason: 'could_not_send_move', type: 'destination_failed'
        });

        assert.deepEqual(late.commands, [ { moveId: preparing.move?.id, type: 'stop_station_consultation' } ]);
        assert.deepEqual(unsent.commands, [ { moveId: preparing.move?.id, type: 'stop_station_consultation' } ]);
    });

    it('lets the consultation run when the patient arrives', () => {
        const preparing = step(initialState(), request([ home, station ]));
        const ready = step(preparing.state, { at: T0, moveId: preparing.move?.id as string, type: 'destination_ready' });
        const arrived = { ...station, occupants: [ ...station.occupants, occupant('e-new', 'pat-1', 'patient') ] };
        const done = step(ready.state, { at: T0, rooms: [ arrived ] as never, type: 'rooms_snapshot' });

        assert.equal(done.state.moves[0].state, 'done');
        assert.deepEqual(done.commands, []);
    });

    it('does not prepare anything for a staff member', () => {
        const staffInHome = { ...home, occupants: [ occupant('e-doc', 'd-1', 'staff') ] };
        const { commands } = step(initialState(), request([ staffInHome, station ], { endpointId: 'e-doc' }));

        assert.deepEqual(commands.map(c => c.type), [ 'send_move', 'start_timer' ]);
    });
});
