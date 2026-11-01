import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { initialState, step } from '../src/patientFlow.ts';
import { Store } from '../src/store.ts';

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
