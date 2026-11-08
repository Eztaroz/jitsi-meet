import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { HttpError } from '../src/http.ts';
import type { ILayout } from '../src/rooms.ts';
import { initialState, step } from '../src/rules.ts';
import { type ISurvey, parseSurvey, placeSurvey, surveysCsv } from '../src/surveys.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const LAYOUT: ILayout = { lounges: [ { room: 'lounge-1' } ], stations: [ { room: 'intake-1', stage: 'intake' } ] };

/**
 * Says the HTTP status a function fails with.
 *
 * @param {Function} fn - The function.
 * @returns {number|undefined}
 */
function statusOf(fn: () => unknown): number | undefined {
    try {
        fn();
    } catch (error) {
        return error instanceof HttpError ? error.status : undefined;
    }

    return undefined;
}

describe('reading a survey', () => {
    it('takes the rating, the tags, the per-aspect ratings, the comment and the room left', () => {
        assert.deepEqual(parseSurvey({
            aspects: { care: 5, quality: 2 },
            comment: '  The sound kept cutting out.\n',
            rating: 2,
            room: '6512345',
            tags: [ 'sound', 'wait' ]
        }), {
            aspects: { care: 5, quality: 2 },
            comment: 'The sound kept cutting out.',
            rating: 2,
            room: '6512345',
            tags: [ 'sound', 'wait' ]
        });
    });

    it('needs only the rating and the room', () => {
        assert.deepEqual(parseSurvey({ rating: 5, room: 'intake-1' }),
            { aspects: {}, comment: undefined, rating: 5, room: 'intake-1', tags: [] });
    });

    it('refuses what is not a survey', () => {
        for (const body of [
            null,
            { room: 'a' },
            { rating: 0, room: 'a' },
            { rating: 6, room: 'a' },
            { rating: 2.5, room: 'a' },
            { rating: 3 },
            { rating: 3, room: '' },
            { rating: 3, room: 'a', tags: [ 'unheard_of' ] },
            { rating: 3, room: 'a', tags: 'sound' },
            { aspects: { overall: 3 }, rating: 3, room: 'a' },
            { aspects: { care: 9 }, rating: 3, room: 'a' },
            { comment: 'x'.repeat(2001), rating: 3, room: 'a' },
            { comment: 42, rating: 3, room: 'a' }
        ]) {
            assert.equal(statusOf(() => parseSurvey(body)), 400, JSON.stringify(body));
        }
    });

    it('keeps each tag once', () => {
        assert.deepEqual(parseSurvey({ rating: 1, room: 'a', tags: [ 'sound', 'sound' ] }).tags, [ 'sound' ]);
    });

    it('drops control characters from the comment, but keeps its lines', () => {
        assert.equal(parseSurvey({ comment: 'one\u0000\ntwo', rating: 4, room: 'a' }).comment, 'one\ntwo');
    });
});

describe('placing a survey', () => {
    const started = step(initialState(), { at: T0, hn: '6512345', type: 'start_encounter' });
    const encounterId = started.encounter?.id as string;

    it('ties it to the HN of the patient\'s own room, as the service knows it, and to its encounter', () => {
        const state = { ...started.state, patientRooms: { 'patient-1': '6512345' } };

        assert.deepEqual(placeSurvey({ identityId: 'patient-1', room: 'intake-1', state, layout: LAYOUT }), {
            encounterId,
            hn: '6512345',
            hnSource: 'known',
            room: 'intake-1',
            stage: 'waiting'
        });
    });

    it('takes the HN from the room left, when that is a patient\'s room and the service does not know theirs', () => {
        assert.deepEqual(placeSurvey({ identityId: 'patient-2', room: '6512345', state: started.state, layout: LAYOUT }), {
            encounterId,
            hn: '6512345',
            hnSource: 'reported',
            room: 'own_room',
            stage: 'waiting'
        });
    });

    it('finds the encounter whatever the case and encoding of the room name', () => {
        const state = step(initialState(), { at: T0, hn: 'HN/7', type: 'start_encounter' }).state;

        assert.equal(placeSurvey({ identityId: 'p', room: 'hn%2f7', state, layout: LAYOUT }).hn, 'HN/7');
    });

    it('ties it to no HN when the patient left a station and the service does not know their room', () => {
        assert.deepEqual(placeSurvey({ identityId: 'patient-3', room: 'Intake-1', state: started.state, layout: LAYOUT }),
            { room: 'intake-1' });
    });

    it('keeps the HN when no encounter has it', () => {
        assert.deepEqual(placeSurvey({ identityId: 'p', room: '6599999', state: started.state, layout: LAYOUT }),
            { hn: '6599999', hnSource: 'reported', room: 'own_room' });
    });
});

describe('the survey report', () => {
    const survey: ISurvey = {
        aspects: { care: 5, ease: 4 },
        comment: 'Good, "thanks"\nsee you',
        encounterId: 'enc-1',
        hn: '6512345',
        hnSource: 'known',
        id: 's-1',
        rating: 4,
        room: 'own_room',
        stage: 'examination',
        submittedAt: new Date('2030-01-01T08:05:00Z'),
        tags: [ 'kind', 'explained' ]
    };

    it('is CSV with a byte order mark, so that a spreadsheet reads Thai, and a header row', () => {
        const csv = surveysCsv([], 'Asia/Bangkok');

        assert.ok(csv.startsWith('﻿'));
        assert.equal(csv.slice(1), 'submitted_at,hn,hn_source,encounter_id,stage,room,rating,ease,quality,wait,care,'
            + 'tags,comment\r\n');
    });

    it('has a row per survey, in the deployment\'s time zone, with quoted text', () => {
        const [ , row ] = surveysCsv([ survey ], 'Asia/Bangkok').split('\r\n');

        assert.equal(row, '2030-01-01 15:05:00,6512345,known,enc-1,examination,own_room,4,4,,,5,kind;explained,'
            + '"Good, ""thanks""\nsee you"');
    });

    it('keeps a spreadsheet from reading a comment as a formula', () => {
        const [ , row ] = surveysCsv([ { ...survey, comment: '=HYPERLINK("x")' } ], 'UTC').split('\r\n');

        assert.ok(row.endsWith(',"\'=HYPERLINK(""x"")"'), row);
    });
});
