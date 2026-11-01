/**
 * Persists the patient-flow module's state in SQLite, so that encounters survive a restart.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { IEncounter, IState } from './patientFlow.ts';

export class Store {
    private readonly _db: DatabaseSync;

    /**
     * Opens, and if need be creates, the database in a directory.
     *
     * @param {string} dir - The directory.
     */
    constructor(dir: string) {
        mkdirSync(dir, { recursive: true });
        this._db = new DatabaseSync(join(dir, 'coordinator.sqlite'));
        this._db.exec(`CREATE TABLE IF NOT EXISTS encounters (
            id TEXT PRIMARY KEY,
            hn TEXT NOT NULL,
            stage TEXT NOT NULL,
            started_at TEXT NOT NULL
        )`);
    }

    /**
     * Reads the saved state.
     *
     * @returns {IState}
     */
    load(): IState {
        const rows = this._db.prepare('SELECT id, hn, stage, started_at FROM encounters ORDER BY started_at').all() as {
            hn: string; id: string; stage: IEncounter['stage']; started_at: string;
        }[];

        return {
            moves: [],
            patientRooms: {},
            encounters: rows.map(r => {
                return { hn: r.hn, id: r.id, stage: r.stage, startedAt: new Date(r.started_at) };
            })
        };
    }

    /**
     * Saves the state, replacing what was saved.
     *
     * @param {IState} state - The state.
     * @returns {void}
     */
    save(state: IState): void {
        const insert = this._db.prepare(
            'INSERT OR REPLACE INTO encounters (id, hn, stage, started_at) VALUES (?, ?, ?, ?)');

        this._db.exec('BEGIN');
        try {
            this._db.exec('DELETE FROM encounters');
            for (const e of state.encounters) {
                insert.run(e.id, e.hn, e.stage, e.startedAt.toISOString());
            }
            this._db.exec('COMMIT');
        } catch (error) {
            this._db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Closes the database.
     *
     * @returns {void}
     */
    close(): void {
        this._db.close();
    }
}
