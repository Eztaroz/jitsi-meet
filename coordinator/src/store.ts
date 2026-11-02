/**
 * Persists the rules module's state in SQLite, so that encounters survive a restart.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { IAuditEntry } from './audit.ts';
import type { IEncounter, IMove, IState } from './rules.ts';

/** What the coordinator service keeps about a move beside the rules module's state, so that a restart can pick it up. */
export interface IMoveRecord {

    /** Whether the move's end is in the audit log. */
    audited: boolean;

    /** The consultation the move started in a station, to stop it if the patient never comes. */
    consultationId?: string;

    /** The absolute deadline of each pending timer. */
    deadlines: { move_arrival?: Date; move_prepare?: Date; };

    /** Who asked: `system`, or a coordinator's verified identity id. */
    issuer: string;
}

/**
 * The record of a move nothing has been kept about yet.
 *
 * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
 * @returns {IMoveRecord}
 */
export function newMoveRecord(issuer = 'system'): IMoveRecord {
    return { audited: false, deadlines: {}, issuer };
}

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

        this._db.exec(`CREATE TABLE IF NOT EXISTS moves (
            id TEXT PRIMARY KEY,
            started_at TEXT NOT NULL,
            move TEXT NOT NULL,
            record TEXT NOT NULL
        )`);

        this._db.exec(`CREATE TABLE IF NOT EXISTS patient_rooms (
            identity_id TEXT PRIMARY KEY,
            room TEXT NOT NULL,
            updated_at TEXT NOT NULL
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
            moves: this._loadMoves().map(({ move }) => move),
            patientRooms: this.patientRooms()
        };
    }

    /**
     * Reads what the coordinator service kept about each saved move.
     *
     * @returns {Map<string, IMoveRecord>} By move id.
     */
    loadMoveRecords(): Map<string, IMoveRecord> {
        return new Map(this._loadMoves().map(({ move, record }) => [ move.id, record ]));
    }

    /**
     * Reads where each patient's own room is, by verified identity id.
     *
     * @returns {Record<string, string>}
     */
    patientRooms(): Record<string, string> {
        const rows = this._db.prepare('SELECT identity_id, room FROM patient_rooms').all() as {
            identity_id: string; room: string;
        }[];

        return Object.fromEntries(rows.map(r => [ r.identity_id, r.room ]));
    }

    /**
     * Reads the saved moves with their records.
     *
     * @returns {Object[]}
     */
    private _loadMoves(): { move: IMove; record: IMoveRecord; }[] {
        const rows = this._db.prepare('SELECT move, record FROM moves ORDER BY started_at').all() as {
            move: string; record: string;
        }[];

        return rows.map(r => {
            const move = JSON.parse(r.move) as IMove & { startedAt: string; };
            const record = JSON.parse(r.record) as Omit<IMoveRecord, 'deadlines'> & {
                deadlines: Record<string, string>;
            };

            return {
                move: { ...move, startedAt: new Date(move.startedAt) },
                record: {
                    ...record,
                    deadlines: {
                        ...record.deadlines.move_arrival ? { move_arrival: new Date(record.deadlines.move_arrival) } : {},
                        ...record.deadlines.move_prepare ? { move_prepare: new Date(record.deadlines.move_prepare) } : {}
                    }
                }
            };
        });
    }

    /**
     * Saves the state, replacing what was saved.
     *
     * @param {IState} state - The state.
     * @param {ReadonlyMap<string, IMoveRecord>} records - What is kept about each move, by move id.
     * @param {IAuditEntry[]} audit - Audit entries to add in the same transaction, so that an entry and the `audited`
     * flag that says it was written are saved together or not at all.
     * @returns {void}
     */
    save(state: IState, records: ReadonlyMap<string, IMoveRecord> = new Map(), audit: IAuditEntry[] = []): void {
        const insert = this._db.prepare(`INSERT OR REPLACE INTO encounters
            (id, hn, stage, started_at, stage_started_at, history, unfinished) VALUES (?, ?, ?, ?, ?, ?, ?)`);

        const keptRooms = new Map((this._db.prepare('SELECT * FROM patient_rooms').all() as {
            identity_id: string; room: string; updated_at: string;
        }[]).map(r => [ r.identity_id, r ]));

        this._db.exec('BEGIN');
        try {
            this._db.exec('DELETE FROM moves');
            for (const m of state.moves) {
                const record = records.get(m.id) ?? newMoveRecord();

                this._db.prepare('INSERT INTO moves (id, started_at, move, record) VALUES (?, ?, ?, ?)')
                    .run(m.id, m.startedAt.toISOString(), JSON.stringify(m), JSON.stringify(record));
            }
            this._db.exec('DELETE FROM patient_rooms');
            for (const [ identityId, room ] of Object.entries(state.patientRooms)) {
                const kept = keptRooms.get(identityId);

                this._db.prepare('INSERT INTO patient_rooms (identity_id, room, updated_at) VALUES (?, ?, ?)')
                    .run(identityId, room, kept?.room === room ? kept.updated_at : new Date().toISOString());
            }
            this._db.exec('DELETE FROM encounters');
            for (const e of state.encounters) {
                insert.run(e.id, e.hn, e.stage, e.startedAt.toISOString(), e.stageStartedAt.toISOString(),
                    JSON.stringify(e.history), e.unfinished ? 1 : 0);
            }
            for (const entry of audit) {
                this.addAudit(entry);
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
     * Marks the patients' own rooms as seen now, so that a room that is seen again unchanged is not swept as old.
     *
     * @param {Record<string, string>} seen - The room each patient was seen in, by verified identity id.
     * @returns {void}
     */
    touchPatientRooms(seen: Record<string, string>): void {
        const touch = this._db.prepare('UPDATE patient_rooms SET updated_at = ? WHERE identity_id = ? AND room = ?');
        const at = new Date().toISOString();

        for (const [ identityId, room ] of Object.entries(seen)) {
            touch.run(at, identityId, room);
        }
    }

    /**
     * Deletes the encounters, moves, patients' own rooms and audit entries older than a time.
     *
     * @param {Date} cutoff - What is older than this goes.
     * @returns {Object} How many of each.
     */
    sweep(cutoff: Date): { audit: number; encounters: number; moves: number; patientRooms: number; } {
        const at = cutoff.toISOString();

        return {
            audit: Number(this._db.prepare('DELETE FROM audit WHERE at < ?').run(at).changes),
            encounters: Number(this._db.prepare('DELETE FROM encounters WHERE started_at < ?').run(at).changes),
            moves: Number(this._db.prepare('DELETE FROM moves WHERE started_at < ?').run(at).changes),
            patientRooms: Number(this._db.prepare('DELETE FROM patient_rooms WHERE updated_at < ?').run(at).changes)
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
