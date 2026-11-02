import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { type IMove, initialState, step } from '../src/rules.ts';
import { Store, newMoveRecord } from '../src/store.ts';

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

        store.save(closed.state);
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

        store.save(fresh.state);
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

        store.save({ ...initialState(), moves: [ move ] }, new Map([ [ 'm-1', { ...newMoveRecord(), audited: true } ] ]),
            [ entry(new Date('2030-01-01T09:00:00Z')) ]);

        assert.equal(store.audit(10).length, 1);
        assert.equal(store.loadMoveRecords().get('m-1')?.audited, true);
    });

    it('saves neither when one of them cannot be saved', () => {
        const store = new Store(mkdtempSync(join(tmpdir(), 'store-')));

        assert.throws(() => store.save({ ...initialState(), moves: [ move ] },
            new Map([ [ 'm-1', { ...newMoveRecord(), audited: true } ] ]), [ entry(new Date(NaN)) ]));

        assert.equal(store.audit(10).length, 0);
        assert.equal(store.loadMoveRecords().size, 0);
    });
});
