import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { ARRIVAL_WAIT_MS, COUNTDOWN_MS, initialState, step } from '../src/patientFlow.ts';

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

    it('refuses, for now, to move a patient', () => {
        const { move } = step(initialState(), request(undefined, { endpointId: 'e-pat', fromRoom: 'patient-a', toRoom: 'lounge-1' }));

        assert.equal(move?.state, 'refused');
        assert.equal(move?.reason, 'only_staff_can_be_moved');
    });
});
