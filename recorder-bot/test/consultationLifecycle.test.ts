import assert from 'node:assert/strict';
import { afterEach, beforeEach, describe, mock, test } from 'node:test';

import {
    type ILifecycleOptions,
    type LifecycleCommand,
    type LifecycleEvent,
    type TimelineEntry,
    createConsultationLifecycle
} from '../src/consultationLifecycle.ts';

const T0 = Date.parse('2026-10-31T09:00:00.000Z');

/**
 * Returns the mocked wall-clock time `ms` milliseconds after the test started.
 *
 * @param {number} ms - Offset from the start of the test.
 * @returns {Date}
 */
function at(ms: number): Date {
    return new Date(T0 + ms);
}

type EventInput = LifecycleEvent extends infer E ? E extends LifecycleEvent ? Omit<E, 'at'> : never : never;

/**
 * Drives a lifecycle module the way the service does: events are stamped with the current time and timer
 * commands are run with real (here: mocked) timers.
 *
 * @param {ILifecycleOptions} options - Lifecycle options.
 * @returns {Object}
 */
function consultation(options?: ILifecycleOptions) {
    const lifecycle = createConsultationLifecycle(options);
    const timers = new Map<string, ReturnType<typeof setTimeout>>();
    const timeline: TimelineEntry[] = [];
    const commands: LifecycleCommand[] = [];

    /**
     * Feeds one event into the module and runs the returned commands.
     *
     * @param {EventInput} event - The event, without its time.
     * @returns {void}
     */
    function send(event: EventInput) {
        const result = lifecycle.handle({ ...event, at: new Date() } as LifecycleEvent);

        timeline.push(...result.entries);
        commands.push(...result.commands);

        for (const command of result.commands) {
            if (command.type === 'start_timer') {
                clearTimeout(timers.get(command.timer));
                timers.set(command.timer, setTimeout(() => {
                    timers.delete(command.timer);
                    send({ type: 'timer_fired', timer: command.timer });
                }, command.ms));
            } else if (command.type === 'cancel_timer') {
                clearTimeout(timers.get(command.timer));
                timers.delete(command.timer);
            }
        }
    }

    return {
        commands,
        send,
        identities: () => lifecycle.identities(),
        participants: () => lifecycle.participants(),
        staffVisits: () => lifecycle.staffVisits(),
        tracks: () => lifecycle.tracks(),
        get stop() {
            const entry = timeline.find(e => e.type === 'stopped');

            return entry?.type === 'stopped' ? { at: entry.at, reason: entry.reason } : undefined;
        },
        timeline
    };
}

beforeEach(() => {
    mock.timers.enable({ apis: [ 'setTimeout', 'Date' ], now: T0 });
});

afterEach(() => {
    mock.timers.reset();
});

describe('first-join wait', () => {
    test('stops with no_one_joined when nobody joins within the wait', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        mock.timers.tick(599_999);
        assert.equal(c.stop, undefined);

        mock.timers.tick(1);
        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
    });

    test('defaults to 10 minutes', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        mock.timers.tick(600_000);

        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
    });

    test('the first human join cancels the wait', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        mock.timers.tick(300_000);
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(3_600_000);

        assert.equal(c.stop, undefined);
    });

    test('is not started when a human is already in the room as the bot joins', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'bot_joined' });
        mock.timers.tick(3_600_000);

        assert.equal(c.stop, undefined);
    });

    test('runs from when the bot starts waiting for a host to start the room', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'waiting_for_host' });
        mock.timers.tick(600_000);

        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
        assert.deepEqual(c.timeline[0], { at: at(0), type: 'waiting_for_host' });
    });

    test('does not start again when the bot joins after waiting for a host', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'waiting_for_host' });
        mock.timers.tick(200_000);
        c.send({ type: 'bot_joined' });
        mock.timers.tick(400_000);

        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
    });
});

describe('stale timers', () => {
    test('a timer reported as fired after it was cancelled is ignored', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'timer_fired', timer: 'first_join' });
        c.send({ type: 'timer_fired', timer: 'empty_room' });

        assert.equal(c.stop, undefined);
    });
});

describe('empty-room grace', () => {
    test('stops with no_humans_for_grace once no human has been present for the grace', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(120_000);
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(59_999);
        assert.equal(c.stop, undefined);

        mock.timers.tick(1);
        assert.deepEqual(c.stop, { at: at(180_000), reason: 'no_humans_for_grace' });
    });

    test('defaults to 60 seconds', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(60_000);

        assert.deepEqual(c.stop, { at: at(60_000), reason: 'no_humans_for_grace' });
    });

    test('a human rejoining within the grace cancels the stop', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(30_000);
        c.send({ type: 'participant_joined', endpointId: 'patient2', role: 'patient' });
        mock.timers.tick(3_600_000);

        assert.equal(c.stop, undefined);
    });

    test('starts again each time the room empties', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(30_000);
        c.send({ type: 'participant_joined', endpointId: 'patient2', role: 'patient' });
        mock.timers.tick(100_000);
        c.send({ type: 'participant_left', endpointId: 'patient2' });
        mock.timers.tick(60_000);

        assert.deepEqual(c.stop, { at: at(190_000), reason: 'no_humans_for_grace' });
    });

    test('is not started while another human is still present', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff' });
        c.send({ type: 'participant_left', endpointId: 'staff1' });
        mock.timers.tick(3_600_000);

        assert.equal(c.stop, undefined);
    });
});

describe('immediate stops', () => {
    test('room destroyed stops at once with room_destroyed', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff' });
        mock.timers.tick(45_000);
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.stop, { at: at(45_000), reason: 'room_destroyed' });
    });

    test('kicked stops at once with kicked', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(10_000);
        c.send({ type: 'kicked' });

        assert.deepEqual(c.stop, { at: at(10_000), reason: 'kicked' });
    });

    test('a service shutdown stops at once with shutdown', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(10_000);
        c.send({ type: 'shutdown' });

        assert.deepEqual(c.stop, { at: at(10_000), reason: 'shutdown' });
    });

    test('a stop cancels the running timers', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'kicked' });

        assert.deepEqual(c.commands, [
            { type: 'start_timer', timer: 'first_join', ms: 600_000 },
            { type: 'cancel_timer', timer: 'first_join' },
            { type: 'stop', reason: 'kicked' }
        ]);
    });

    test('events after the stop produce no commands and no timeline entries', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'room_destroyed' });
        const before = { commands: c.commands.length, timeline: c.timeline.length };

        c.send({ type: 'participant_left', endpointId: 'patient1' });
        c.send({ type: 'kicked' });
        mock.timers.tick(3_600_000);

        assert.deepEqual({ commands: c.commands.length, timeline: c.timeline.length }, before);
    });
});

describe('hidden participants', () => {
    test('a hidden participant does not cancel the first-join wait', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'jibri1', role: 'unknown', hidden: true });
        mock.timers.tick(600_000);

        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
    });

    test('a hidden participant coming and going does not restart the grace', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(10_000);
        c.send({ type: 'participant_joined', endpointId: 'jibri1', role: 'unknown', hidden: true });
        mock.timers.tick(20_000);
        c.send({ type: 'participant_left', endpointId: 'jibri1' });
        mock.timers.tick(30_000);

        assert.deepEqual(c.stop, { at: at(60_000), reason: 'no_humans_for_grace' });
    });

    test('a hidden participant does not keep an empty room open', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'jibri1', role: 'unknown', hidden: true });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(60_000);

        assert.deepEqual(c.stop, { at: at(60_000), reason: 'no_humans_for_grace' });
    });

    test('neither starts nor cancels a timer', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        const before = c.commands.length;

        c.send({ type: 'participant_joined', endpointId: 'jibri1', role: 'unknown', hidden: true });
        c.send({ type: 'participant_left', endpointId: 'jibri1' });

        assert.equal(c.commands.length, before);
    });
});

describe('staff visits', () => {
    const staffA = { id: 'staff-a@hospital', name: 'Dr A' };
    const staffB = { id: 'staff-b@hospital', name: 'Nurse B' };

    test('one continuous presence of a staff endpoint is one visit', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(12_000);
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA, displayName: 'A' });
        mock.timers.tick(16_000);
        c.send({ type: 'participant_left', endpointId: 'staff1' });

        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staff1', identity: staffA, displayName: 'A', start: at(12_000), end: at(28_000) }
        ]);
    });

    test('a rejoin starts a new visit', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        mock.timers.tick(10_000);
        c.send({ type: 'participant_left', endpointId: 'staff1' });
        mock.timers.tick(30_000);
        c.send({ type: 'participant_joined', endpointId: 'staff2', role: 'staff', identity: staffA });
        mock.timers.tick(5_000);
        c.send({ type: 'participant_left', endpointId: 'staff2' });

        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staff1', identity: staffA, displayName: undefined, start: at(0), end: at(10_000) },
            { endpointId: 'staff2', identity: staffA, displayName: undefined, start: at(40_000), end: at(45_000) }
        ]);
    });

    test('overlapping visits by different staff stay separate', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(1_000);
        c.send({ type: 'participant_joined', endpointId: 'staffA1', role: 'staff', identity: staffA });
        mock.timers.tick(1_000);
        c.send({ type: 'participant_joined', endpointId: 'staffB1', role: 'staff', identity: staffB });
        mock.timers.tick(1_000);
        c.send({ type: 'participant_left', endpointId: 'staffA1' });
        mock.timers.tick(1_000);
        c.send({ type: 'participant_left', endpointId: 'staffB1' });

        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staffA1', identity: staffA, displayName: undefined, start: at(1_000), end: at(3_000) },
            { endpointId: 'staffB1', identity: staffB, displayName: undefined, start: at(2_000), end: at(4_000) }
        ]);
    });

    test('a visit still open at the stop closes at the stop time', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(5_000);
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        mock.timers.tick(20_000);
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staff1', identity: staffA, displayName: undefined, start: at(5_000), end: at(25_000) }
        ]);
    });

    test('a visit still in progress has no end', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });

        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staff1', identity: staffA, displayName: undefined, start: at(0), end: undefined }
        ]);
    });

    test('patients and participants of unknown role make no visits', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'guest1', role: 'unknown' });
        c.send({ type: 'participant_left', endpointId: 'guest1' });
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.staffVisits(), []);
    });
});

describe('interruption gaps', () => {
    test('an interruption and the resume after it produce a gap entry', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(20_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(7_000);
        c.send({ type: 'bot_resumed' });

        assert.deepEqual(c.timeline.filter(e => e.type === 'gap'), [
            { at: at(27_000), type: 'gap', start: at(20_000), end: at(27_000) }
        ]);
    });

    test('a gap still open at the stop ends at the stop time', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(20_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(5_000);
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.timeline.filter(e => e.type === 'gap'), [
            { at: at(25_000), type: 'gap', start: at(20_000), end: at(25_000) }
        ]);
    });

    test('each interruption is its own gap', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(1_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(1_000);
        c.send({ type: 'bot_resumed' });
        mock.timers.tick(1_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(2_000);
        c.send({ type: 'bot_resumed' });

        assert.deepEqual(c.timeline.filter(e => e.type === 'gap'), [
            { at: at(2_000), type: 'gap', start: at(1_000), end: at(2_000) },
            { at: at(5_000), type: 'gap', start: at(3_000), end: at(5_000) }
        ]);
    });
});

describe('interruptions', () => {
    test('tracks still recorded when the bot is interrupted end then', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'track_started', endpointId: 'patient1', file: '01-patient1-audio.webm', kind: 'audio' });
        mock.timers.tick(20_000);
        c.send({ type: 'bot_interrupted' });

        assert.deepEqual(c.tracks().map(t => [ t.file, t.stop ]), [ [ '01-patient1-audio.webm', at(20_000) ] ]);
        assert.deepEqual(c.timeline.slice(-2), [
            { at: at(20_000), type: 'bot_interrupted' },
            { at: at(20_000), file: '01-patient1-audio.webm', type: 'track_stopped' }
        ]);
    });

    test('a participant the resumed bot finds in the room stays, with no new join', () => {
        const staffA = { id: 'staff-a@hospital' };
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(5_000);

        // The relaunched bot is told who is in the room as it joins.
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        c.send({ type: 'bot_resumed' });

        assert.deepEqual(c.participants().map(p => [ p.endpointId, p.joins, p.leaves ]), [
            [ 'patient1', [ at(0) ], [] ],
            [ 'staff1', [ at(0) ], [] ]
        ]);
        assert.deepEqual(c.staffVisits(), [
            { endpointId: 'staff1', identity: staffA, displayName: undefined, start: at(0), end: undefined }
        ]);
        assert.deepEqual(c.timeline.filter(e => e.type === 'participant_joined').length, 2);
    });

    test('a participant the resumed bot does not find left during the gap; the bot learns it at the resume', () => {
        const staffA = { id: 'staff-a@hospital' };
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(5_000);
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'participant_joined', endpointId: 'staff2', role: 'staff', identity: staffA });
        c.send({ type: 'bot_resumed' });

        assert.deepEqual(c.participants().map(p => [ p.endpointId, p.joins, p.leaves ]), [
            [ 'patient1', [ at(0) ], [] ],
            [ 'staff1', [ at(0) ], [ at(15_000) ] ],
            [ 'staff2', [ at(15_000) ], [] ]
        ]);
        assert.deepEqual(c.staffVisits().map(v => [ v.endpointId, v.start, v.end ]), [
            [ 'staff1', at(0), at(15_000) ],
            [ 'staff2', at(15_000), undefined ]
        ]);
        assert.deepEqual(c.timeline.slice(-3), [
            { at: at(15_000), type: 'bot_resumed' },
            { at: at(15_000), type: 'gap', start: at(10_000), end: at(15_000) },
            { at: at(15_000), endpointId: 'staff1', type: 'participant_left' }
        ]);
    });

    test('if everyone left during the gap, the empty-room grace runs from the resume', () => {
        const c = consultation({ emptyRoomMs: 60_000 });

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(5_000);
        c.send({ type: 'bot_resumed' });
        mock.timers.tick(59_999);
        assert.equal(c.stop, undefined);

        mock.timers.tick(1);
        assert.deepEqual(c.stop, { at: at(75_000), reason: 'no_humans_for_grace' });
    });

    test('the first-join wait runs on through an interruption', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_joined' });
        mock.timers.tick(300_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_resumed' });
        mock.timers.tick(290_000);

        assert.deepEqual(c.stop, { at: at(600_000), reason: 'no_one_joined' });
    });

    test('a bot interrupted before it ever joined starts the first-join wait when it resumes', () => {
        const c = consultation({ firstJoinMs: 600_000 });

        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_resumed' });
        mock.timers.tick(600_000);

        assert.deepEqual(c.stop, { at: at(610_000), reason: 'no_one_joined' });
    });

    test('a resume without an interruption changes nothing', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'bot_resumed' });

        assert.deepEqual(c.participants().map(p => p.leaves), [ [] ]);
        assert.deepEqual(c.timeline.filter(e => e.type === 'gap' || e.type === 'participant_left'), []);
    });

    test('a bot that fails for good stops the consultation, ending the gap', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(10_000);
        c.send({ type: 'bot_interrupted' });
        mock.timers.tick(5_000);
        c.send({ type: 'bot_failed' });

        assert.deepEqual(c.stop, { at: at(15_000), reason: 'bot_failed' });
        assert.deepEqual(c.timeline.filter(e => e.type === 'gap'), [
            { at: at(15_000), type: 'gap', start: at(10_000), end: at(15_000) }
        ]);
    });
});

describe('timeline', () => {
    test('records every event at its time, ending with the stop reason', () => {
        const c = consultation();
        const identity = { id: 'staff-a@hospital' };

        c.send({ type: 'bot_joined', meetingId: 'meeting-1' });
        mock.timers.tick(2_000);
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient', displayName: 'P' });
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'audio', file: '01-patient1-audio.webm' });
        mock.timers.tick(3_000);
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity });
        mock.timers.tick(4_000);
        c.send({ type: 'track_stopped', file: '01-patient1-audio.webm' });
        c.send({ type: 'participant_left', endpointId: 'patient1' });
        mock.timers.tick(1_000);
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.timeline, [
            { at: at(0), type: 'bot_joined', meetingId: 'meeting-1' },
            {
                at: at(2_000),
                type: 'participant_joined',
                endpointId: 'patient1',
                role: 'patient',
                displayName: 'P',
                identity: undefined
            },
            {
                at: at(2_000),
                type: 'track_started',
                endpointId: 'patient1',
                kind: 'audio',
                file: '01-patient1-audio.webm'
            },
            {
                at: at(5_000),
                type: 'participant_joined',
                endpointId: 'staff1',
                role: 'staff',
                displayName: undefined,
                identity
            },
            { at: at(9_000), type: 'track_stopped', file: '01-patient1-audio.webm' },
            { at: at(9_000), type: 'participant_left', endpointId: 'patient1' },
            { at: at(10_000), type: 'stopped', reason: 'room_destroyed' }
        ]);
    });
});

describe('tracks', () => {
    test('a change of video resolution is recorded against its file', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'video', file: '01-patient1-video.webm' });
        mock.timers.tick(3_000);
        c.send({ type: 'video_resolution', file: '01-patient1-video.webm', width: 320, height: 180 });

        assert.deepEqual(c.timeline.filter(e => e.type === 'video_resolution'), [
            { at: at(3_000), type: 'video_resolution', file: '01-patient1-video.webm', width: 320, height: 180 }
        ]);
    });

    test('a track still open at the stop ends at the stop time, before the stop entry', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'audio', file: '01-patient1-audio.webm' });
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'video', file: '02-patient1-video.webm' });
        mock.timers.tick(4_000);
        c.send({ type: 'track_stopped', file: '01-patient1-audio.webm' });
        mock.timers.tick(6_000);
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.timeline.slice(-3), [
            { at: at(4_000), type: 'track_stopped', file: '01-patient1-audio.webm' },
            { at: at(10_000), type: 'track_stopped', file: '02-patient1-video.webm' },
            { at: at(10_000), type: 'stopped', reason: 'room_destroyed' }
        ]);
    });
});

describe('track list', () => {
    test('lists each track with its start and stop; one still open at the stop ends at the stop time', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient' });
        mock.timers.tick(1_000);
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'audio', file: '01-patient1-audio.webm' });
        mock.timers.tick(1_000);
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'video', file: '02-patient1-video.webm' });
        mock.timers.tick(5_000);
        c.send({ type: 'track_stopped', file: '02-patient1-video.webm' });
        mock.timers.tick(3_000);
        c.send({ type: 'shutdown' });

        assert.deepEqual(c.tracks(), [
            { endpointId: 'patient1', file: '01-patient1-audio.webm', kind: 'audio', start: at(1_000), stop: at(10_000) },
            { endpointId: 'patient1', file: '02-patient1-video.webm', kind: 'video', start: at(2_000), stop: at(7_000) }
        ]);
    });

    test('a track still in progress has no stop', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'track_started', endpointId: 'patient1', kind: 'audio', file: '01-patient1-audio.webm' });

        assert.deepEqual(c.tracks(), [
            { endpointId: 'patient1', file: '01-patient1-audio.webm', kind: 'audio', start: at(0), stop: undefined }
        ]);
    });
});

describe('participants', () => {
    test('lists each endpoint with its joins and leaves, in the order they first joined', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient', displayName: 'P' });
        mock.timers.tick(2_000);
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'unknown', displayName: 'S' });
        mock.timers.tick(3_000);
        c.send({ type: 'participant_left', endpointId: 'staff1' });
        mock.timers.tick(1_000);
        c.send({ type: 'participant_joined', endpointId: 'other1', role: 'unknown', hidden: true });
        c.send({ type: 'room_destroyed' });

        assert.deepEqual(c.participants(), [
            {
                endpointId: 'patient1',
                displayName: 'P',
                identity: undefined,
                role: 'patient',
                joins: [ at(0) ],
                leaves: []
            },
            {
                endpointId: 'staff1',
                displayName: 'S',
                identity: undefined,
                role: 'unknown',
                joins: [ at(2_000) ],
                leaves: [ at(5_000) ]
            },
            {
                endpointId: 'other1',
                displayName: undefined,
                hidden: true,
                identity: undefined,
                role: 'unknown',
                joins: [ at(6_000) ],
                leaves: []
            }
        ]);
    });
});

describe('identities', () => {
    const staffA = { id: 'staff-a@hospital', name: 'Dr A' };
    const patientP = { id: 'patient-p', name: 'Patient P' };

    test('groups the endpoints and files of each verified identity, across rejoins', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'patient', identity: patientP });
        c.send({ type: 'track_started', endpointId: 'patient1', file: '01-patient1-audio.webm', kind: 'audio' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'staff', identity: staffA });
        c.send({ type: 'track_started', endpointId: 'staff1', file: '02-staff1-audio.webm', kind: 'audio' });
        c.send({ type: 'track_started', endpointId: 'staff1', file: '03-staff1-video.webm', kind: 'video' });
        c.send({ type: 'participant_left', endpointId: 'staff1' });
        c.send({ type: 'participant_joined', endpointId: 'guest1', role: 'unknown' });
        c.send({ type: 'track_started', endpointId: 'guest1', file: '04-guest1-audio.webm', kind: 'audio' });
        c.send({ type: 'participant_joined', endpointId: 'staff2', role: 'staff', identity: staffA });
        c.send({ type: 'track_started', endpointId: 'staff2', file: '05-staff2-audio.webm', kind: 'audio' });
        c.send({ type: 'track_started', endpointId: 'patient1', file: '06-patient1-video.webm', kind: 'video' });

        assert.deepEqual(c.identities(), [
            {
                identity: patientP,
                role: 'patient',
                endpointIds: [ 'patient1' ],
                files: [ '01-patient1-audio.webm', '06-patient1-video.webm' ]
            },
            {
                identity: staffA,
                role: 'staff',
                endpointIds: [ 'staff1', 'staff2' ],
                files: [ '02-staff1-audio.webm', '03-staff1-video.webm', '05-staff2-audio.webm' ]
            }
        ]);
    });

    test('without verified identities there are none', () => {
        const c = consultation();

        c.send({ type: 'bot_joined' });
        c.send({ type: 'participant_joined', endpointId: 'patient1', role: 'unknown' });
        c.send({ type: 'participant_joined', endpointId: 'staff1', role: 'unknown' });

        assert.deepEqual(c.identities(), []);
        assert.deepEqual(c.staffVisits(), []);
    });
});
