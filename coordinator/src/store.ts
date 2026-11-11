/**
 * Persists the rules module's state in SQLite, one change at a time, so that encounters survive a restart.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

import type { IAuditEntry } from './audit.ts';
import { DEFAULT_PATHWAY_ID } from './pathways.ts';
import type { ISentQuestionnaire } from './questionnaires.ts';
import type { IEncounter, IMove, IState } from './rules.ts';
import type { StoreChange } from './stateChanges.ts';
import type { ISurvey } from './surveys.ts';

/** What the coordinator service keeps about a move beside the rules module's state, so that a restart can pick it up. */
export interface IMoveRecord {

    /** Whether the move's end is in the audit log. */
    audited: boolean;

    /** The absolute deadline of each pending timer. */
    deadlines: { move_arrival?: Date; };

    /** Who asked: `system`, or a coordinator's verified identity id. */
    issuer: string;
}

/** A consultation: one stretch of a patient's room that a recorder bot records as an evidence recording (ADR 0016). */
export interface IConsultation {

    /** The encounter the room was opened for. */
    encounterId: string;

    /** Made by the coordinator service, never by the recorder bot. It names the evidence recording. */
    id: string;

    /** The worker id of the recorder bot that records it. */
    recorderBot: string;

    /** Whether it is being recorded. */
    recording: boolean;
    startedAt: Date;
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

/**
 * Reads the health questionnaires of an encounter back from their JSON, with their dates.
 *
 * @param {string} json - What was saved.
 * @returns {ISentQuestionnaire[]}
 */
function readQuestionnaires(json: string): ISentQuestionnaire[] {
    type Saved = Omit<ISentQuestionnaire, 'answeredAt' | 'closedAt' | 'sentAt'> & {
        answeredAt?: string; closedAt?: string; sentAt: string;
    };

    return (JSON.parse(json) as Saved[]).map(q => ({
        ...q,
        answeredAt: q.answeredAt ? new Date(q.answeredAt) : undefined,
        closedAt: q.closedAt ? new Date(q.closedAt) : undefined,
        sentAt: new Date(q.sentAt)
    }));
}

/** What the coordinator service keeps its state in: SQLite (`Store`) or MariaDB (`MariaDbStore`). Every call is synchronous. */
export interface IStore {

    /**
     * Writes changes, in order, in one transaction: all of them are saved or none.
     *
     * @param {StoreChange[]} changes - What to write.
     * @returns {void}
     */
    apply(changes: StoreChange[]): void;

    /** Adds an entry to the audit log. */
    addAudit(entry: IAuditEntry): void;

    /** Keeps a satisfaction survey. */
    addSurvey(survey: ISurvey): void;

    /** Reads every consultation, the oldest first. */
    allConsultations(): IConsultation[];

    /** Reads the newest audit entries, the newest first. */
    audit(limit: number): IAuditEntry[];

    /** Closes the database. */
    close(): void;

    /** Reads the consultations of an encounter, the oldest first. */
    consultationsOf(encounterId: string): IConsultation[];

    /** Reads the saved state. */
    load(): IState;

    /** Reads what the coordinator service kept about each saved move, by move id. */
    loadMoveRecords(): Map<string, IMoveRecord>;

    /** Reads where each patient's own room is, by verified identity id. */
    patientRooms(): Record<string, string>;

    /** Reads the station of each staff member, by verified identity id. */
    staffStations(): Record<string, string>;

    /** Deletes what is older than a time, and says how many of each. */
    sweep(cutoff: Date): ISweepResult;

    /** Reads the satisfaction surveys submitted in a period, the oldest first. */
    surveys(from: Date, to: Date): ISurvey[];

    /** Marks the patients' own rooms as seen now. */
    touchPatientRooms(seen: Record<string, string>): void;

    /** Marks the staff's stations as seen now. */
    touchStaffStations(seen: Record<string, string>): void;
}

/** How many rows a retention sweep deleted, of each kind. */
export type ISweepResult = {
    audit: number;
    consultations: number;
    encounters: number;
    moves: number;
    patientRooms: number;
    staffStations: number;
    surveys: number;
};

/** A row of the `encounters` table, as either database returns it. */
export interface IEncounterRow {
    center: string | null; clinic: string | null; doctor: string | null; history: string | null; hn: string;
    id: string; pathway: string | null; questionnaires: string | null; stage: IEncounter['stage'];
    stage_started_at: string | null; started_at: string;
    unfinished: number | null; videos: string | null; visit_number: string | null;
}

/** A row of the `consultations` table, as either database returns it. */
export interface IConsultationRow {
    encounter_id: string; id: string; recorder_bot: string; recording: number; started_at: string;
}

/**
 * Makes an encounter of a saved row.
 *
 * @param {IEncounterRow} r - The row.
 * @returns {IEncounter}
 */
export function encounterOfRow(r: IEncounterRow): IEncounter {
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

        // An encounter stored before pathways followed the only one there was.
        pathway: r.pathway ?? DEFAULT_PATHWAY_ID,
        stage: r.stage,
        stageStartedAt,
        startedAt,
        ...r.center ? { center: r.center } : {},
        ...r.clinic ? { clinic: r.clinic } : {},
        ...r.doctor ? { doctor: r.doctor } : {},
        ...r.questionnaires ? { questionnaires: readQuestionnaires(r.questionnaires) } : {},
        ...r.unfinished ? { unfinished: true as const } : {},
        ...r.videos ? { videos: JSON.parse(r.videos) as Record<string, string> } : {},
        ...r.visit_number ? { visitNumber: r.visit_number } : {}
    };
}

/**
 * Makes a consultation of a saved row.
 *
 * @param {IConsultationRow} r - The row.
 * @returns {IConsultation}
 */
export function consultationOfRow(r: IConsultationRow): IConsultation {
    return {
        encounterId: r.encounter_id,
        id: r.id,
        recorderBot: r.recorder_bot,
        recording: Boolean(r.recording),
        startedAt: new Date(r.started_at)
    };
}

/**
 * Reads a saved move and its record back, with their dates.
 *
 * @param {string} moveJson - The saved move.
 * @param {string} recordJson - The saved record.
 * @returns {Object}
 */
export function moveOfRow(moveJson: string, recordJson: string): { move: IMove; record: IMoveRecord; } {
    const move = JSON.parse(moveJson) as IMove & { startedAt: string; };

    // A record from when patients were moved may also hold a consultation id and a preparation deadline.
    const record = JSON.parse(recordJson) as Omit<IMoveRecord, 'deadlines'> & {
        deadlines: Record<string, string>;
    };

    return {
        move: { ...move, startedAt: new Date(move.startedAt) },
        record: {
            audited: record.audited,
            deadlines: record.deadlines.move_arrival ? { move_arrival: new Date(record.deadlines.move_arrival) } : {},
            issuer: record.issuer
        }
    };
}

/**
 * Reads a saved audit entry back, with its date.
 *
 * @param {string} json - What was saved.
 * @returns {IAuditEntry}
 */
export function auditOfRow(json: string): IAuditEntry {
    const entry = JSON.parse(json) as IAuditEntry;

    return { ...entry, at: new Date(entry.at) };
}

/**
 * Reads a saved survey back, with its date.
 *
 * @param {string} json - What was saved.
 * @returns {ISurvey}
 */
export function surveyOfRow(json: string): ISurvey {
    const survey = JSON.parse(json) as ISurvey & { submittedAt: string; };

    return { ...survey, submittedAt: new Date(survey.submittedAt) };
}

export class Store implements IStore {
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

        this._db.exec(`CREATE TABLE IF NOT EXISTS staff_stations (
            identity_id TEXT PRIMARY KEY,
            station TEXT NOT NULL,
            updated_at TEXT NOT NULL
        )`);

        this._db.exec(`CREATE TABLE IF NOT EXISTS surveys (
            id TEXT PRIMARY KEY,
            submitted_at TEXT NOT NULL,
            survey TEXT NOT NULL
        )`);
        this._db.exec('CREATE INDEX IF NOT EXISTS surveys_submitted_at ON surveys (submitted_at)');

        this._db.exec(`CREATE TABLE IF NOT EXISTS consultations (
            id TEXT PRIMARY KEY,
            encounter_id TEXT NOT NULL,
            recorder_bot TEXT NOT NULL,
            recording INTEGER NOT NULL,
            started_at TEXT NOT NULL
        )`);
        this._db.exec('CREATE INDEX IF NOT EXISTS consultations_encounter ON consultations (encounter_id)');

        // A database made before stages or pathways gets the columns added.
        const columns = (this._db.prepare('PRAGMA table_info(encounters)').all() as { name: string; }[]).map(c => c.name);

        for (const [ name, type ] of [ [ 'stage_started_at', 'TEXT' ], [ 'history', 'TEXT' ], [ 'unfinished', 'INTEGER' ], [ 'pathway', 'TEXT' ],
            [ 'visit_number', 'TEXT' ], [ 'center', 'TEXT' ], [ 'clinic', 'TEXT' ], [ 'doctor', 'TEXT' ],
            [ 'questionnaires', 'TEXT' ], [ 'videos', 'TEXT' ] ]) {
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
        const rows = this._db.prepare('SELECT * FROM encounters ORDER BY started_at').all() as unknown as IEncounterRow[];

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
     * Reads the consultations of an encounter, and so which evidence recordings belong to it.
     *
     * @param {string} encounterId - The encounter.
     * @returns {IConsultation[]} The oldest first.
     */
    consultationsOf(encounterId: string): IConsultation[] {
        const rows = this._db.prepare('SELECT * FROM consultations WHERE encounter_id = ? ORDER BY started_at, id')
            .all(encounterId) as unknown as IConsultationRow[];

        return rows.map(consultationOfRow);
    }

    /**
     * Reads every consultation.
     *
     * @returns {IConsultation[]} The oldest first.
     */
    allConsultations(): IConsultation[] {
        const rows = this._db.prepare('SELECT * FROM consultations ORDER BY started_at, id').all() as unknown as IConsultationRow[];

        return rows.map(consultationOfRow);
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
     * Reads the station of each staff member, by verified identity id.
     *
     * @returns {Record<string, string>}
     */
    staffStations(): Record<string, string> {
        const rows = this._db.prepare('SELECT identity_id, station FROM staff_stations').all() as {
            identity_id: string; station: string;
        }[];

        return Object.fromEntries(rows.map(r => [ r.identity_id, r.station ]));
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

        return rows.map(r => moveOfRow(r.move, r.record));
    }

    /**
     * Writes changes, in order, in one transaction: all of them are saved or none.
     *
     * @param {StoreChange[]} changes - What to write.
     * @returns {void}
     */
    apply(changes: StoreChange[]): void {
        if (!changes.length) {
            return;
        }
        this._db.exec('BEGIN');
        try {
            for (const change of changes) {
                this._write(change);
            }
            this._db.exec('COMMIT');
        } catch (error) {
            this._db.exec('ROLLBACK');
            throw error;
        }
    }

    /**
     * Writes one change.
     *
     * @param {StoreChange} change - The change.
     * @returns {void}
     */
    private _write(change: StoreChange): void {
        const now = new Date().toISOString();

        switch (change.kind) {
        case 'audit':
            this.addAudit(change.audit);
            break;
        case 'consultation': {
            const c = change.consultation;

            this._db.prepare(`INSERT OR REPLACE INTO consultations (id, encounter_id, recorder_bot, recording, started_at)
                VALUES (?, ?, ?, ?, ?)`)
                .run(c.id, c.encounterId, c.recorderBot, c.recording ? 1 : 0, c.startedAt.toISOString());
            break;
        }
        case 'encounter': {
            const e = change.encounter;

            this._db.prepare(`INSERT OR REPLACE INTO encounters
                (id, hn, stage, started_at, stage_started_at, history, unfinished, pathway, visit_number, center, clinic,
                    doctor, questionnaires, videos)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
                .run(e.id, e.hn, e.stage, e.startedAt.toISOString(), e.stageStartedAt.toISOString(),
                    JSON.stringify(e.history), e.unfinished ? 1 : 0, e.pathway, e.visitNumber ?? null, e.center ?? null,
                    e.clinic ?? null, e.doctor ?? null, e.questionnaires?.length ? JSON.stringify(e.questionnaires) : null,
                    e.videos && Object.keys(e.videos).length ? JSON.stringify(e.videos) : null);
            break;
        }
        case 'move':
            this._db.prepare('INSERT OR REPLACE INTO moves (id, started_at, move, record) VALUES (?, ?, ?, ?)')
                .run(change.move.id, change.move.startedAt.toISOString(), JSON.stringify(change.move),
                    JSON.stringify(change.record));
            break;
        case 'patient_room':
            if (change.room === undefined) {
                this._db.prepare('DELETE FROM patient_rooms WHERE identity_id = ?').run(change.identityId);
            } else {
                this._db.prepare('INSERT OR REPLACE INTO patient_rooms (identity_id, room, updated_at) VALUES (?, ?, ?)')
                    .run(change.identityId, change.room, now);
            }
            break;
        case 'staff_station':
            if (change.station === undefined) {
                this._db.prepare('DELETE FROM staff_stations WHERE identity_id = ?').run(change.identityId);
            } else {
                this._db.prepare('INSERT OR REPLACE INTO staff_stations (identity_id, station, updated_at) VALUES (?, ?, ?)')
                    .run(change.identityId, change.station, now);
            }
            break;
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

        return rows.map(r => auditOfRow(r.entry));
    }

    /**
     * Keeps a satisfaction survey.
     *
     * @param {ISurvey} survey - The survey.
     * @returns {void}
     */
    addSurvey(survey: ISurvey): void {
        this._db.prepare('INSERT INTO surveys (id, submitted_at, survey) VALUES (?, ?, ?)')
            .run(survey.id, survey.submittedAt.toISOString(), JSON.stringify(survey));
    }

    /**
     * Reads the satisfaction surveys submitted in a period.
     *
     * @param {Date} from - The start of the period, included.
     * @param {Date} to - The end of the period, included.
     * @returns {ISurvey[]} The oldest first.
     */
    surveys(from: Date, to: Date): ISurvey[] {
        const rows = this._db.prepare(
            'SELECT survey FROM surveys WHERE submitted_at >= ? AND submitted_at <= ? ORDER BY submitted_at, id'
        ).all(from.toISOString(), to.toISOString()) as { survey: string; }[];

        return rows.map(r => surveyOfRow(r.survey));
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
     * Marks the staff's stations as seen now, so that a station that is seen again unchanged is not swept as old.
     *
     * @param {Record<string, string>} seen - The station whose lounge each staff member was seen in, by verified
     * identity id.
     * @returns {void}
     */
    touchStaffStations(seen: Record<string, string>): void {
        const touch = this._db.prepare('UPDATE staff_stations SET updated_at = ? WHERE identity_id = ? AND station = ?');
        const at = new Date().toISOString();

        for (const [ identityId, station ] of Object.entries(seen)) {
            touch.run(at, identityId, station);
        }
    }

    /**
     * Deletes the encounters, moves, patients' own rooms, staff's stations, surveys and audit entries older than a
     * time.
     *
     * @param {Date} cutoff - What is older than this goes.
     * @returns {Object} How many of each.
     */
    sweep(cutoff: Date): ISweepResult {
        const at = cutoff.toISOString();

        return {
            audit: Number(this._db.prepare('DELETE FROM audit WHERE at < ?').run(at).changes),
            consultations: Number(this._db.prepare('DELETE FROM consultations WHERE started_at < ?').run(at).changes),
            encounters: Number(this._db.prepare('DELETE FROM encounters WHERE started_at < ?').run(at).changes),
            moves: Number(this._db.prepare('DELETE FROM moves WHERE started_at < ?').run(at).changes),
            patientRooms: Number(this._db.prepare('DELETE FROM patient_rooms WHERE updated_at < ?').run(at).changes),
            staffStations: Number(this._db.prepare('DELETE FROM staff_stations WHERE updated_at < ?').run(at).changes),
            surveys: Number(this._db.prepare('DELETE FROM surveys WHERE submitted_at < ?').run(at).changes)
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
