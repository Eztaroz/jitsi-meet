/**
 * Persists the patient-flow module's state in SQLite, so that encounters survive a restart.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { IAuditEntry } from './audit.ts';
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

        this._db.exec(`CREATE TABLE IF NOT EXISTS audit (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            at TEXT NOT NULL,
            entry TEXT NOT NULL
        )`);

        // A database made before stages gets the columns added.
        const columns = (this._db.prepare('PRAGMA table_info(encounters)').all() as { name: string; }[]).map(c => c.name);

        for (const [ name, type ] of [ [ 'stage_started_at', 'TEXT' ], [ 'history', 'TEXT' ], [ 'unfinished', 'INTEGER' ] ]) {
            if (!columns.includes(name)) {
                this._db.exec(`ALTER TABLE encounters ADD COLUMN ${name} ${type}`);
            }
        }
    }

    /**
     * Reads the saved state.
     *
     * @returns {IState}
     */
    load(): IState {
        const rows = this._db.prepare('SELECT * FROM encounters ORDER BY started_at').all() as {
            history: string | null; hn: string; id: string; stage: IEncounter['stage']; stage_started_at: string | null;
            started_at: string; unfinished: number | null;
        }[];

        return {
            encounters: rows.map(r => {
                const startedAt = new Date(r.started_at);
                const stageStartedAt = new Date(r.stage_started_at ?? r.started_at);
                const history = r.history
                    ? (JSON.parse(r.history) as { at: string; stage: IEncounter['stage']; }[])
                        .map(h => ({ at: new Date(h.at), stage: h.stage }))
                    : [ { at: stageStartedAt, stage: r.stage } ];

                return {
                    history,
                    hn: r.hn,
                    id: r.id,
                    stage: r.stage,
                    stageStartedAt,
                    startedAt,
                    ...r.unfinished ? { unfinished: true as const } : {}
                };
            }),
            moves: [],
            patientRooms: {}
        };
    }

    /**
     * Saves the state, replacing what was saved.
     *
     * @param {IState} state - The state.
     * @returns {void}
     */
    save(state: IState): void {
        const insert = this._db.prepare(`INSERT OR REPLACE INTO encounters
            (id, hn, stage, started_at, stage_started_at, history, unfinished) VALUES (?, ?, ?, ?, ?, ?, ?)`);

        this._db.exec('BEGIN');
        try {
            this._db.exec('DELETE FROM encounters');
            for (const e of state.encounters) {
                insert.run(e.id, e.hn, e.stage, e.startedAt.toISOString(), e.stageStartedAt.toISOString(),
                    JSON.stringify(e.history), e.unfinished ? 1 : 0);
            }
            this._db.exec('COMMIT');
        } catch (error) {
            this._db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Adds an entry to the audit log.
     *
     * @param {IAuditEntry} entry - The entry.
     * @returns {void}
     */
    addAudit(entry: IAuditEntry): void {
        this._db.prepare('INSERT INTO audit (at, entry) VALUES (?, ?)').run(entry.at.toISOString(), JSON.stringify(entry));
    }

    /**
     * Reads the newest audit entries.
     *
     * @param {number} limit - How many.
     * @returns {IAuditEntry[]} The newest first.
     */
    audit(limit: number): IAuditEntry[] {
        const rows = this._db.prepare('SELECT entry FROM audit ORDER BY at DESC, id DESC LIMIT ?').all(limit) as { entry: string; }[];

        return rows.map(r => {
            const entry = JSON.parse(r.entry) as IAuditEntry;

            return { ...entry, at: new Date(entry.at) };
        });
    }

    /**
     * Deletes the encounters and the audit entries older than a time.
     *
     * @param {Date} cutoff - What is older than this goes.
     * @returns {Object} How many of each.
     */
    sweep(cutoff: Date): { audit: number; encounters: number; } {
        const at = cutoff.toISOString();

        return {
            audit: Number(this._db.prepare('DELETE FROM audit WHERE at < ?').run(at).changes),
            encounters: Number(this._db.prepare('DELETE FROM encounters WHERE started_at < ?').run(at).changes)
        };
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
