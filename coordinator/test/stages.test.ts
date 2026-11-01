import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { nextMidnight } from '../src/midnight.ts';
import { initialState, queues, step } from '../src/patientFlow.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const at = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

/**
 * Starts encounters for some HNs, a second apart, and returns the state with their ids.
 *
 * @param {string[]} hns - The HNs.
 * @returns {Object}
 */
function started(...hns: string[]) {
    let state = initialState();
    const ids: string[] = [];

    hns.forEach((hn, i) => {
        const result = step(state, { at: at(i), hn, type: 'start_encounter' });

        state = result.state;
        ids.push(result.encounter?.id as string);
    });

    return { ids, state };
}

describe('changing an encounter\'s stage', () => {
    it('goes forward, skips a stage, and goes back, each time entering the new stage afresh', () => {
        const { ids, state } = started('A');
        const toIntake = step(state, { at: at(60), encounterId: ids[0], stage: 'intake', type: 'change_stage' });
        const skipped = step(toIntake.state, { at: at(120), encounterId: ids[0], stage: 'aftercare', type: 'change_stage' });
        const back = step(skipped.state, { at: at(180), encounterId: ids[0], stage: 'waiting', type: 'change_stage' });

        assert.equal(toIntake.encounter?.stage, 'intake');
        assert.equal(skipped.encounter?.stage, 'aftercare');
        assert.equal(back.encounter?.stage, 'waiting');
        assert.deepEqual(back.state.encounters[0].stageStartedAt, at(180));
    });

    it('keeps the stage history', () => {
        const { ids, state } = started('A');
        const s1 = step(state, { at: at(60), encounterId: ids[0], stage: 'intake', type: 'change_stage' });
        const s2 = step(s1.state, { at: at(120), encounterId: ids[0], stage: 'examination', type: 'change_stage' });

        assert.deepEqual(s2.state.encounters[0].history, [
            { at: at(0), stage: 'waiting' }, { at: at(60), stage: 'intake' }, { at: at(120), stage: 'examination' }
        ]);
    });

    it('refuses an encounter that does not exist, and one that is done', () => {
        const { ids, state } = started('A');
        const unknown = step(state, { at: at(1), encounterId: 'nope', stage: 'intake', type: 'change_stage' });
        const done = step(state, { at: at(2), encounterId: ids[0], stage: 'done', type: 'change_stage' });
        const after = step(done.state, { at: at(3), encounterId: ids[0], stage: 'intake', type: 'change_stage' });

        assert.equal(unknown.refused, 'unknown_encounter');
        assert.equal(after.refused, 'encounter_closed');
        assert.equal(after.state.encounters[0].stage, 'done');
    });

    it('lets an HN start a new encounter once its last one is done', () => {
        const { ids, state } = started('A');
        const done = step(state, { at: at(2), encounterId: ids[0], stage: 'done', type: 'change_stage' });
        const again = step(done.state, { at: at(3), hn: 'A', type: 'start_encounter' });

        assert.equal(again.encounter?.created, true);
        assert.notEqual(again.encounter?.id, ids[0]);
    });
});

describe('the queues', () => {
    it('hold the open encounters of each stage, the longest-waiting first, with how long each has waited', () => {
        const { ids, state } = started('A', 'B', 'C');
        const moved = step(state, { at: at(10), encounterId: ids[0], stage: 'intake', type: 'change_stage' });
        const q = queues(moved.state, at(70));

        assert.deepEqual(q.waiting.map(e => [ e.encounterId, e.waitedSeconds ]), [ [ ids[1], 69 ], [ ids[2], 68 ] ]);
        assert.deepEqual(q.intake.map(e => [ e.encounterId, e.waitedSeconds ]), [ [ ids[0], 60 ] ]);
        assert.deepEqual(q.examination, []);
        assert.deepEqual(q.aftercare, []);
    });

    it('suggest the first of each queue only', () => {
        const { ids, state } = started('A', 'B');
        const q = queues(state, at(30));

        assert.deepEqual(q.waiting.map(e => [ e.encounterId, e.suggested ]), [ [ ids[0], true ], [ ids[1], false ] ]);
    });

    it('order by when the encounter entered the stage, not when it started', () => {
        const { ids, state } = started('A', 'B');
        const s1 = step(state, { at: at(10), encounterId: ids[1], stage: 'examination', type: 'change_stage' });
        const s2 = step(s1.state, { at: at(20), encounterId: ids[0], stage: 'examination', type: 'change_stage' });

        assert.deepEqual(queues(s2.state, at(30)).examination.map(e => e.encounterId), [ ids[1], ids[0] ]);
    });

    it('do not hold an encounter that is done', () => {
        const { ids, state } = started('A');
        const done = step(state, { at: at(5), encounterId: ids[0], stage: 'done', type: 'change_stage' });
        const q = queues(done.state, at(10));

        assert.deepEqual([ q.waiting, q.intake, q.examination, q.aftercare ], [ [], [], [], [] ]);
    });
});

describe('moving a participant', () => {
    it('does not change any encounter\'s stage', () => {
        const { state } = started('A');
        const room = { name: 'a', occupants: [ { endpointId: 'e1', identity: { id: 'u' }, role: 'staff' as const } ] };
        const other = { name: 'b', occupants: [] };
        const moved = step(state, { at: at(5), endpointId: 'e1', fromRoom: 'a', rooms: [ room, other ], toRoom: 'b', type: 'request_move' });

        assert.deepEqual(moved.state.encounters, state.encounters);
    });
});

describe('the end of the day', () => {
    it('closes the encounters still open as unfinished, and leaves the finished ones as they are', () => {
        const { ids, state } = started('A', 'B', 'C');
        const done = step(state, { at: at(5), encounterId: ids[1], stage: 'done', type: 'change_stage' });
        const closed = step(done.state, { at: at(600), type: 'close_day' });
        const byId = Object.fromEntries(closed.state.encounters.map(e => [ e.id, e ]));

        assert.deepEqual([ ids[0], ids[2] ].map(id => [ byId[id].stage, byId[id].unfinished ]), [ [ 'done', true ], [ 'done', true ] ]);
        assert.equal(byId[ids[1]].unfinished, undefined);
        assert.deepEqual(byId[ids[1]].history.at(-1), { at: at(5), stage: 'done' });
        assert.deepEqual(byId[ids[0]].history.at(-1), { at: at(600), stage: 'done' });
        assert.deepEqual(queues(closed.state, at(601)).waiting, []);
    });
});

describe('the next midnight', () => {
    it('is midnight in the configured time zone', () => {
        // 23:30 in Bangkok (UTC+7) on 1 January.
        assert.equal(nextMidnight(new Date('2030-01-01T16:30:00Z'), 'Asia/Bangkok').toISOString(), '2030-01-01T17:00:00.000Z');
    });

    it('is the next one when it is midnight exactly', () => {
        assert.equal(nextMidnight(new Date('2030-01-01T17:00:00Z'), 'Asia/Bangkok').toISOString(), '2030-01-02T17:00:00.000Z');
    });

    it('is UTC midnight by default', () => {
        assert.equal(nextMidnight(new Date('2030-01-01T08:00:00Z')).toISOString(), '2030-01-02T00:00:00.000Z');
    });

    it('follows daylight saving time', () => {
        // New York goes to summer time on 10 March 2030 at 02:00: the day is 23 hours long.
        assert.equal(nextMidnight(new Date('2030-03-10T06:00:00Z'), 'America/New_York').toISOString(), '2030-03-11T04:00:00.000Z');
    });
});
