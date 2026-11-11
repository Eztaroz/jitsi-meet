/**
 * Keeps the coordinator service's state in MariaDB (ADR 0015), behind the same interface as the SQLite store.
 */
import type { IAuditEntry } from './audit.ts';
import { MariaDbClient } from './mariadbClient.ts';
import type { IStatement } from './mariadbWorker.ts';
import { applyMigrations } from './migrations.ts';
import type { IState } from './rules.ts';
import type { StoreChange } from './stateChanges.ts';
import {
    type IConsultation,
    type IConsultationRow,
    type IEncounterRow,
    type IMoveRecord,
    type IStore,
    type ISweepResult,
    auditOfRow,
    consultationOfRow,
    encounterOfRow,
    moveOfRow,
    surveyOfRow
} from './store.ts';
import type { ISurvey } from './surveys.ts';

/** Where the coordinator service's MariaDB schema is, and the user that owns it. */
export interface IMariaDbConfig {
    database: string;
    host: string;
    password: string;
    port: number;
    user: string;
}

/**
 * Makes the statement that writes one change.
 *
 * @param {StoreChange} change - The change.
 * @param {string} now - The time to record on a room or a station, as ISO 8601.
 * @returns {IStatement}
 */
function statementOf(change: StoreChange, now: string): IStatement {
    switch (change.kind) {
    case 'audit':
        return {
            params: [ change.audit.at.toISOString(), JSON.stringify(change.audit) ],
            sql: 'INSERT INTO audit (at, entry) VALUES (?, ?)'
        };
    case 'consultation': {
        const c = change.consultation;

        return {
            params: [ c.id, c.encounterId, c.recorderBot, c.recording ? 1 : 0, c.startedAt.toISOString() ],
            sql: 'REPLACE INTO consultations (id, encounter_id, recorder_bot, recording, started_at) VALUES (?, ?, ?, ?, ?)'
        };
    }
    case 'encounter': {
        const e = change.encounter;

        return {
            params: [ e.id, e.hn, e.stage, e.startedAt.toISOString(), e.stageStartedAt.toISOString(), JSON.stringify(e.history),
                e.unfinished ? 1 : 0, e.pathway, e.visitNumber ?? null, e.center ?? null, e.clinic ?? null, e.doctor ?? null,
                e.questionnaires?.length ? JSON.stringify(e.questionnaires) : null,
                e.videos && Object.keys(e.videos).length ? JSON.stringify(e.videos) : null ],
            sql: `REPLACE INTO encounters
                (id, hn, stage, started_at, stage_started_at, history, unfinished, pathway, visit_number, center, clinic,
                    doctor, questionnaires, videos)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        };
    }
    case 'move':
        return {
            params: [ change.move.id, change.move.startedAt.toISOString(), JSON.stringify(change.move), JSON.stringify(change.record) ],
            sql: 'REPLACE INTO moves (id, started_at, move, record) VALUES (?, ?, ?, ?)'
        };
    case 'patient_room':
        return change.room === undefined
            ? { params: [ change.identityId ], sql: 'DELETE FROM patient_rooms WHERE identity_id = ?' }
            : {
                params: [ change.identityId, change.room, now ],
                sql: 'REPLACE INTO patient_rooms (identity_id, room, updated_at) VALUES (?, ?, ?)'
            };
    case 'staff_station':
        return change.station === undefined
            ? { params: [ change.identityId ], sql: 'DELETE FROM staff_stations WHERE identity_id = ?' }
            : {
                params: [ change.identityId, change.station, now ],
                sql: 'REPLACE INTO staff_stations (identity_id, station, updated_at) VALUES (?, ?, ?)'
            };
    }
}

export class MariaDbStore implements IStore {
    private readonly _client: MariaDbClient;

    /** The numbers of the migrations this start applied; empty when the schema was up to date. */
    readonly migrationsApplied: number[];

    /**
     * Connects and brings the schema up to date. It throws when the database cannot be reached.
     *
     * @param {IMariaDbConfig} config - Where the database is.
     */
    constructor(config: IMariaDbConfig) {
        this._client = new MariaDbClient(config);
        try {
            this.migrationsApplied = applyMigrations(this._client);
        } catch (error) {
            this._client.close();
            throw error;
        }
    }

    /**
     * Reads the saved state.
     *
     * @returns {IState}
     */
    load(): IState {
        const rows = this._client.select<IEncounterRow>('SELECT * FROM encounters ORDER BY started_at');

        return {
            encounters: rows.map(encounterOfRow),
            moves: this._loadMoves().map(({ move }) => move),
            patientRooms: this.patientRooms(),
            staffStations: this.staffStations()
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
     * Reads the consultations of an encounter.
     *
     * @param {string} encounterId - The encounter.
     * @returns {IConsultation[]} The oldest first.
     */
    consultationsOf(encounterId: string): IConsultation[] {
        return this._client.select<IConsultationRow>(
            'SELECT * FROM consultations WHERE encounter_id = ? ORDER BY started_at, id', [ encounterId ]
        ).map(consultationOfRow);
    }

    /**
     * Reads every consultation.
     *
     * @returns {IConsultation[]} The oldest first.
     */
    allConsultations(): IConsultation[] {
        return this._client.select<IConsultationRow>('SELECT * FROM consultations ORDER BY started_at, id').map(consultationOfRow);
    }

    /**
     * Reads where each patient's own room is, by verified identity id.
     *
     * @returns {Record<string, string>}
     */
    patientRooms(): Record<string, string> {
        const rows = this._client.select<{ identity_id: string; room: string; }>('SELECT identity_id, room FROM patient_rooms');

        return Object.fromEntries(rows.map(r => [ r.identity_id, r.room ]));
    }

    /**
     * Reads the station of each staff member, by verified identity id.
     *
     * @returns {Record<string, string>}
     */
    staffStations(): Record<string, string> {
        const rows = this._client.select<{ identity_id: string; station: string; }>('SELECT identity_id, station FROM staff_stations');

        return Object.fromEntries(rows.map(r => [ r.identity_id, r.station ]));
    }

    /**
     * Writes changes, in order, in one transaction: all of them are saved or none.
     *
     * @param {StoreChange[]} changes - What to write.
     * @returns {void}
     */
    apply(changes: StoreChange[]): void {
        const now = new Date().toISOString();

        this._client.batch(changes.map(change => statementOf(change, now)));
    }

    /**
     * Adds an entry to the audit log.
     *
     * @param {IAuditEntry} entry - The entry.
     * @returns {void}
     */
    addAudit(entry: IAuditEntry): void {
        this.apply([ { audit: entry, kind: 'audit' } ]);
    }

    /**
     * Reads the newest audit entries.
     *
     * @param {number} limit - How many.
     * @returns {IAuditEntry[]} The newest first.
     */
    audit(limit: number): IAuditEntry[] {
        return this._client.select<{ entry: string; }>('SELECT entry FROM audit ORDER BY at DESC, id DESC LIMIT ?', [ limit ])
            .map(r => auditOfRow(r.entry));
    }

    /**
     * Keeps a satisfaction survey.
     *
     * @param {ISurvey} survey - The survey.
     * @returns {void}
     */
    addSurvey(survey: ISurvey): void {
        this._client.query('INSERT INTO surveys (id, submitted_at, survey) VALUES (?, ?, ?)',
            [ survey.id, survey.submittedAt.toISOString(), JSON.stringify(survey) ]);
    }

    /**
     * Reads the satisfaction surveys submitted in a period.
     *
     * @param {Date} from - The start of the period, included.
     * @param {Date} to - The end of the period, included.
     * @returns {ISurvey[]} The oldest first.
     */
    surveys(from: Date, to: Date): ISurvey[] {
        return this._client.select<{ survey: string; }>(
            'SELECT survey FROM surveys WHERE submitted_at >= ? AND submitted_at <= ? ORDER BY submitted_at, id',
            [ from.toISOString(), to.toISOString() ]
        ).map(r => surveyOfRow(r.survey));
    }

    /**
     * Marks the patients' own rooms as seen now, so that a room that is seen again unchanged is not swept as old.
     *
     * @param {Record<string, string>} seen - The room each patient was seen in, by verified identity id.
     * @returns {void}
     */
    touchPatientRooms(seen: Record<string, string>): void {
        const at = new Date().toISOString();

        this._client.batch(Object.entries(seen).map(([ identityId, room ]) => {
            return { params: [ at, identityId, room ], sql: 'UPDATE patient_rooms SET updated_at = ? WHERE identity_id = ? AND room = ?' };
        }));
    }

    /**
     * Marks the staff's stations as seen now, so that a station that is seen again unchanged is not swept as old.
     *
     * @param {Record<string, string>} seen - The station whose lounge each staff member was seen in, by verified
     * identity id.
     * @returns {void}
     */
    touchStaffStations(seen: Record<string, string>): void {
        const at = new Date().toISOString();

        this._client.batch(Object.entries(seen).map(([ identityId, station ]) => {
            return {
                params: [ at, identityId, station ],
                sql: 'UPDATE staff_stations SET updated_at = ? WHERE identity_id = ? AND station = ?'
            };
        }));
    }

    /**
     * Deletes the encounters, moves, patients' own rooms, staff's stations, surveys, consultations and audit entries
     * older than a time.
     *
     * @param {Date} cutoff - What is older than this goes.
     * @returns {ISweepResult} How many of each.
     */
    sweep(cutoff: Date): ISweepResult {
        const at = cutoff.toISOString();
        const tables: [ keyof ISweepResult, string, string ][] = [
            [ 'audit', 'audit', 'at' ],
            [ 'consultations', 'consultations', 'started_at' ],
            [ 'encounters', 'encounters', 'started_at' ],
            [ 'moves', 'moves', 'started_at' ],
            [ 'patientRooms', 'patient_rooms', 'updated_at' ],
            [ 'staffStations', 'staff_stations', 'updated_at' ],
            [ 'surveys', 'surveys', 'submitted_at' ]
        ];
        const results = this._client.batch(tables.map(([ , table, column ]) => {
            return { params: [ at ], sql: `DELETE FROM ${table} WHERE ${column} < ?` };
        }));

        return Object.fromEntries(tables.map(([ key ], i) => [ key, 'affectedRows' in results[i] ? results[i].affectedRows : 0 ])) as
            ISweepResult;
    }

    /**
     * Closes the connection.
     *
     * @returns {void}
     */
    close(): void {
        this._client.close();
    }

    /**
     * Reads the saved moves with their records.
     *
     * @returns {Object[]}
     */
    private _loadMoves() {
        return this._client.select<{ move: string; record: string; }>('SELECT move, record FROM moves ORDER BY started_at')
            .map(r => moveOfRow(r.move, r.record));
    }
}
