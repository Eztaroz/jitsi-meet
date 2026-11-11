import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { type IMove, initialState, step } from '../src/rules.ts';
import { diffState } from '../src/stateChanges.ts';
import { Store, newMoveRecord } from '../src/store.ts';
import type { ISurvey } from '../src/surveys.ts';

const T0 = new Date('2030-01-01T08:00:00Z');

describe('the store', () => {
    it('keeps encounters, with their stage history and whether they were left unfinished, across a restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const started = step(initialState(), { at: T0, hn: 'A', type: 'start_encounter' });
        const moved = step(started.state, {
            at: new Date(T0.getTime() + 60_000), encounterId: started.encounter?.id as string, stage: 'intake', type: 'change_stage'
        });
        const closed = step(moved.state, { at: new Date(T0.getTime() + 120_000), type: 'close_day' });
        const store = new Store(dir);

        store.apply(closed.state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })));
        store.close();

        const loaded = new Store(dir).load();

        assert.deepEqual(loaded.encounters, closed.state.encounters);
        assert.equal(loaded.encounters[0].unfinished, true);
        assert.deepEqual(loaded.encounters[0].history.map(h => h.stage), [ 'waiting', 'intake', 'done' ]);
    });

    it('opens a database made before stages, giving its encounters a history of the stage they were in', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const old = new DatabaseSync(join(dir, 'coordinator.sqlite'));

        old.exec('CREATE TABLE encounters (id TEXT PRIMARY KEY, hn TEXT NOT NULL, stage TEXT NOT NULL, started_at TEXT NOT NULL)');
        old.prepare('INSERT INTO encounters VALUES (?, ?, ?, ?)').run('e1', 'A', 'waiting', T0.toISOString());
        old.close();

        const [ encounter ] = new Store(dir).load().encounters;

        assert.equal(encounter.stage, 'waiting');
        assert.deepEqual(encounter.stageStartedAt, T0);
        assert.deepEqual(encounter.history, [ { at: T0, stage: 'waiting' } ]);
    });
});

describe('writing what changed', () => {
    it('writes one encounter and leaves the others as they were', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const a = step(initialState(), { at: T0, hn: 'A', type: 'start_encounter' });
        const b = step(a.state, { at: new Date(T0.getTime() + 500), hn: 'B', type: 'start_encounter' });
        const staged = step(b.state, { at: new Date(T0.getTime() + 1000), encounterId: a.encounter?.id as string, stage: 'intake', type: 'change_stage' });
        const store = new Store(dir);

        store.apply(b.state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })));
        store.apply([ { encounter: staged.state.encounters.find(e => e.hn === 'A') as never, kind: 'encounter' } ]);
        store.close();

        assert.deepEqual(new Store(dir).load().encounters, staged.state.encounters);
    });

    it('keeps the rooms of patients and the stations of staff, and deletes one on request', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const store = new Store(dir);

        store.apply([ { identityId: 'p1', kind: 'patient_room', room: 'r1' }, { identityId: 'p2', kind: 'patient_room', room: 'r2' },
            { identityId: 's1', kind: 'staff_station', station: 'intake' } ]);
        store.apply([ { identityId: 'p1', kind: 'patient_room', room: undefined } ]);
        store.close();

        const loaded = new Store(dir);

        assert.deepEqual(loaded.patientRooms(), { p2: 'r2' });
        assert.deepEqual(loaded.staffStations(), { s1: 'intake' });
    });
});

describe('what changed between two states', () => {
    it('lists only the encounters, moves and rooms that are new or different, then the audit entries', () => {
        const a = step(initialState(), { at: T0, hn: 'A', type: 'start_encounter' });
        const b = step(a.state, { at: new Date(T0.getTime() + 500), hn: 'B', type: 'start_encounter' });
        const entry = { at: T0, issuer: 'system', kind: 'stage' as const, outcome: 'ok', encounterId: 'e', from: 'waiting' as const, to: 'intake' as const };
        const next = { ...b.state, patientRooms: { p1: 'r1' } };

        assert.deepEqual(diffState(a.state, next, new Map(), new Map(), [ entry ]), [
            { encounter: b.state.encounters[1], kind: 'encounter' },
            { identityId: 'p1', kind: 'patient_room', room: 'r1' },
            { audit: entry, kind: 'audit' }
        ]);
        assert.deepEqual(diffState(next, next, new Map(), new Map()), []);
    });
});

describe('the audit log and the retention sweep', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const entry = (at: Date) => ({ at, issuer: 'system', kind: 'stage' as const, outcome: 'ok', encounterId: 'e', from: 'waiting' as const, to: 'intake' as const });

    it('keeps audit entries, the newest first', () => {
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        store.addAudit(entry(new Date('2030-01-01T08:00:00Z')));
        store.addAudit(entry(new Date('2030-01-01T09:00:00Z')));

        assert.deepEqual(store.audit(10).map(e => e.at.toISOString()), [ '2030-01-01T09:00:00.000Z', '2030-01-01T08:00:00.000Z' ]);
    });

    it('deletes the audit entries and encounters older than the retention period and leaves the rest', () => {
        const now = new Date('2030-06-01T00:00:00Z');
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));
        const old = step(initialState(), { at: new Date(now.getTime() - 100 * DAY), hn: 'OLD', type: 'start_encounter' });
        const fresh = step(old.state, { at: new Date(now.getTime() - 10 * DAY), hn: 'NEW', type: 'start_encounter' });

        store.apply(fresh.state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })));
        store.addAudit(entry(new Date(now.getTime() - 100 * DAY)));
        store.addAudit(entry(new Date(now.getTime() - 10 * DAY)));

        const removed = store.sweep(new Date(now.getTime() - 90 * DAY));

        assert.equal(removed.audit, 1);
        assert.equal(removed.encounters, 1);
        assert.deepEqual(store.load().encounters.map(e => e.hn), [ 'NEW' ]);
        assert.equal(store.audit(10).length, 1);
    });
});

describe('saving audit entries with the moves', () => {
    const move = {
        destination: 'b', endpointId: 'e', fromRoom: 'a', id: 'm-1', startedAt: new Date('2030-01-01T08:00:00Z'),
        state: 'done', toRoom: 'b'
    } as unknown as IMove;
    const entry = (at: Date) => ({ at, issuer: 'system', kind: 'stage' as const, outcome: 'ok', encounterId: 'e', from: 'waiting' as const, to: 'intake' as const });

    it('saves the entries and the audited flag together', () => {
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        store.apply([ { kind: 'move', move, record: { ...newMoveRecord(), audited: true } },
            { audit: entry(new Date('2030-01-01T09:00:00Z')), kind: 'audit' } ]);

        assert.equal(store.audit(10).length, 1);
        assert.equal(store.loadMoveRecords().get('m-1')?.audited, true);
    });

    it('saves neither when one of them cannot be saved', () => {
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        assert.throws(() => store.apply([ { kind: 'move', move, record: { ...newMoveRecord(), audited: true } },
            { audit: entry(new Date(NaN)), kind: 'audit' } ]));

        assert.equal(store.audit(10).length, 0);
        assert.equal(store.loadMoveRecords().size, 0);
    });
});

describe('the satisfaction surveys', () => {
    const DAY = 24 * 60 * 60 * 1000;
    const survey = (id: string, submittedAt: Date): ISurvey => ({
        aspects: { care: 5 },
        comment: 'ขอบคุณครับ',
        encounterId: 'enc-1',
        hn: '6512345',
        hnSource: 'known',
        id,
        rating: 5,
        room: 'own_room',
        stage: 'examination',
        submittedAt,
        tags: [ 'kind' ]
    });

    it('keeps surveys across a restart and reads those of a period, oldest first', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const store = new Store(dir);

        store.addSurvey(survey('b', new Date('2030-01-02T08:00:00Z')));
        store.addSurvey(survey('a', new Date('2030-01-01T08:00:00Z')));
        store.addSurvey(survey('c', new Date('2030-01-03T08:00:00Z')));
        store.close();

        const surveys = new Store(dir).surveys(new Date('2030-01-01T00:00:00Z'), new Date('2030-01-02T23:59:59Z'));

        assert.deepEqual(surveys, [ survey('a', new Date('2030-01-01T08:00:00Z')), survey('b', new Date('2030-01-02T08:00:00Z')) ]);
    });

    it('deletes the surveys older than the retention period', () => {
        const now = new Date('2030-06-01T00:00:00Z');
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        store.addSurvey(survey('old', new Date(now.getTime() - 100 * DAY)));
        store.addSurvey(survey('new', new Date(now.getTime() - 10 * DAY)));

        assert.equal(store.sweep(new Date(now.getTime() - 90 * DAY)).surveys, 1);
        assert.deepEqual(store.surveys(new Date(0), now).map(s => s.id), [ 'new' ]);
    });
});

describe('consultations', () => {
    const consultation = (id: string, encounterId: string, recording = true) =>
        ({ encounterId, id, recorderBot: 'bot-1', recording, startedAt: T0 });

    it('keeps each consultation, with its encounter, recorder bot and whether it is recording, across a restart', () => {
        const dir = mkdtempSync(join(tmpdir(), 'store-'));
        const store = new Store(dir);

        store.apply([ { consultation: consultation('c1', 'e1'), kind: 'consultation' },
            { consultation: consultation('c2', 'e2'), kind: 'consultation' } ]);
        store.apply([ { consultation: consultation('c1', 'e1', false), kind: 'consultation' } ]);
        store.close();

        const loaded = new Store(dir);

        assert.deepEqual(loaded.consultationsOf('e1'), [ consultation('c1', 'e1', false) ]);
        assert.deepEqual(loaded.consultationsOf('e2'), [ consultation('c2', 'e2') ]);
        assert.deepEqual(loaded.consultationsOf('nope'), []);
    });

    it('sweeps the consultations older than the retention period', () => {
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        store.apply([ { consultation: consultation('c1', 'e1'), kind: 'consultation' } ]);

        assert.equal(store.sweep(new Date(T0.getTime() + 1000)).consultations, 1);
        assert.deepEqual(store.consultationsOf('e1'), []);
    });
});
