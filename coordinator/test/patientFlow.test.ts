import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { initialState, step } from '../src/patientFlow.ts';

const T0 = new Date('2030-01-01T08:00:00Z');

describe('starting an encounter', () => {
    it('opens an encounter in the waiting stage and asks the recorder bot to record the patient\'s room', () => {
        const { commands, result, state } = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });

        assert.equal(result?.stage, 'waiting');
        assert.equal(result?.hn, 'TEST-1');
        assert.equal(result?.created, true);
        assert.deepEqual(commands, [ { hn: 'TEST-1', type: 'record_room' } ]);
        assert.equal(state.encounters.length, 1);
    });

    it('returns the open encounter for an HN that already has one, and asks the recorder bot nothing new', () => {
        const first = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });
        const again = step(first.state, { at: new Date(T0.getTime() + 1000), hn: 'TEST-1', type: 'start_encounter' });

        assert.equal(again.result?.id, first.result?.id);
        assert.equal(again.result?.created, false);
        assert.deepEqual(again.commands, []);
        assert.equal(again.state.encounters.length, 1);
    });

    it('gives each HN its own encounter with its own opaque id', () => {
        const a = step(initialState(), { at: T0, hn: 'TEST-1', type: 'start_encounter' });
        const b = step(a.state, { at: T0, hn: 'TEST-2', type: 'start_encounter' });

        assert.notEqual(a.result?.id, b.result?.id);
        assert.doesNotMatch(String(a.result?.id), /TEST/u);
        assert.equal(b.state.encounters.length, 2);
    });
});
