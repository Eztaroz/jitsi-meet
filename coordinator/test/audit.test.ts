import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { auditRef, moveEntry, stageEntry } from '../src/audit.ts';
import type { IMove } from '../src/rules.ts';

const layout = {
    centers: [ { id: 'center-1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' as const } ] } ]
};
const T = new Date('2030-01-01T08:00:00Z');

describe('referring to a room in the audit log', () => {
    it('names a station\'s lounge as it is, since that is not patient data', () => {
        assert.equal(auditRef('key', 'lounge-intake', layout), 'lounge-intake');
        assert.equal(auditRef('key', 'Lounge-Intake', layout), 'Lounge-Intake');
    });

    it('refers to a patient\'s room by a keyed reference that does not contain the HN', () => {
        const ref = auditRef('key', 'HN/12345', layout);

        assert.match(ref, /^room:[0-9a-f]{16}$/u);
        assert.ok(!ref.toLowerCase().includes('12345'));
    });

    it('gives one room one reference, whatever the case, and another room another', () => {
        assert.equal(auditRef('key', 'HN/12345', layout), auditRef('key', 'hn/12345', layout));
        assert.notEqual(auditRef('key', 'HN/12345', layout), auditRef('key', 'HN/12346', layout));
    });

    it('depends on the key', () => {
        assert.notEqual(auditRef('key-a', 'HN/12345', layout), auditRef('key-b', 'HN/12345', layout));
    });
});

describe('the audit entry of a move', () => {
    const move = (over: Partial<IMove>): IMove => ({
        destination: 'lounge-intake', endpointId: 'e1', id: 'm-1', identityId: 'u-1', origin: 'HN/12345', startedAt: T,
        state: 'done', ...over
    });

    it('records who asked, who was moved, from where to where, and the outcome, without the HN', () => {
        const entry = moveEntry(move({}), { at: T, issuer: 'system', key: 'key', layout });

        assert.deepEqual(entry, {
            at: T,
            destination: 'lounge-intake',
            issuer: 'system',
            kind: 'move',
            outcome: 'done',
            participantId: 'u-1',
            reason: undefined,
            source: auditRef('key', 'HN/12345', layout)
        });
        assert.ok(!JSON.stringify(entry).toLowerCase().includes('12345'));
    });

    it('records the reason a move was refused or failed, and who the coordinator was', () => {
        const refused = moveEntry(move({ reason: 'patients_never_move', state: 'refused' }), {
            at: T, issuer: 'coordinator-7', key: 'key', layout
        });
        const failed = moveEntry(move({ reason: 'participant_did_not_arrive', state: 'failed' }), {
            at: T, issuer: 'system', key: 'key', layout
        });

        assert.deepEqual([ refused.outcome, refused.reason, refused.issuer ], [ 'refused', 'patients_never_move', 'coordinator-7' ]);
        assert.deepEqual([ failed.outcome, failed.reason ], [ 'failed', 'participant_did_not_arrive' ]);
    });
});

describe('the audit entry of a stage change', () => {
    it('records who changed which encounter from which stage to which, by the encounter\'s id', () => {
        assert.deepEqual(stageEntry({ at: T, encounterId: 'enc-1', from: 'waiting', issuer: 'system', outcome: 'ok', to: 'intake' }), {
            at: T,
            encounterId: 'enc-1',
            from: 'waiting',
            issuer: 'system',
            kind: 'stage',
            outcome: 'ok',
            reason: undefined,
            to: 'intake'
        });
    });
});
