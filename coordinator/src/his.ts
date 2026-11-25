/**
 * Reads a patient's appointments of a day from the hospital's system (HIS), read only (ADR 0019). The service starts
 * the encounter of a patient who joins their own room with an appointment that day. The HIS has no visit number, so an
 * appointment is known by its HN, date, clinic code and doctor code, the primary key of its table.
 */
import { type Pool, createPool } from 'mariadb';

/** Where the HIS database is. The user is given `SELECT` on the appointments table and nothing else. */
export interface IHisConfig {
    database: string;
    host: string;
    password: string;
    port: number;
    user: string;
}

/** One appointment, without anything about the patient but the HN the lookup was for. */
export interface IAppointment {

    /** The HIS clinic code (`CODE_AP`). */
    clinicCode: string;

    /** The day, as `YYYY-MM-DD`. */
    date: string;

    /** The HIS doctor code (`C_DOCT`). */
    doctorCode: number;

    /** The time of day, as the HIS keeps it (`HH:MM`), if it has one. */
    time?: string;
}

/** What gives a patient's appointments of a day. */
export interface IAppointmentSource {

    /**
     * The patient's appointments on that day, the earliest first.
     *
     * @param {string} hn - The HN.
     * @param {string} date - The day, as `YYYY-MM-DD`.
     * @returns {Promise<IAppointment[]>}
     */
    appointments: (hn: string, date: string) => Promise<IAppointment[]>;
}

/**
 * The statement that reads the appointments. It names its columns, so no name or other detail of the patient is read,
 * and orders them so that the earliest comes first, an appointment with no time last.
 */
export const APPOINTMENTS_SQL = 'SELECT DATE_FORMAT(DATE_AP, \'%Y-%m-%d\') AS date_ap, TIME_AP AS time_ap, '
    + 'CODE_AP AS code_ap, C_DOCT AS c_doct FROM Appoint WHERE HN = ? AND DATE_AP = ? '
    + 'ORDER BY TIME_AP IS NULL OR TIME_AP = \'\', TIME_AP, CODE_AP, C_DOCT';

/**
 * Turns the rows of `APPOINTMENTS_SQL` into appointments.
 *
 * @param {Object[]} rows - The rows.
 * @returns {IAppointment[]}
 */
export function appointmentsFrom(rows: Record<string, unknown>[]): IAppointment[] {
    return rows.map(row => {
        const time = typeof row.time_ap === 'string' ? row.time_ap.trim() : '';

        return {
            clinicCode: String(row.code_ap ?? '').trim(),
            date: String(row.date_ap),
            doctorCode: Number(row.c_doct),
            ...time ? { time } : {}
        };
    });
}

/**
 * The key the service keeps as an encounter's visit number for an appointment: with the encounter's HN it is the
 * appointment's primary key in the HIS, and it holds no HN itself.
 *
 * @param {IAppointment} appointment - The appointment.
 * @returns {string} Such as `2026-11-25/ABC/1234`.
 */
export function appointmentKey(appointment: IAppointment): string {
    return `${appointment.date}/${appointment.clinicCode}/${appointment.doctorCode}`;
}

/** Reads the appointments from the HIS's MariaDB, on a small pool of read-only connections. */
export class HisAppointments implements IAppointmentSource {
    private readonly _pool: Pool;

    /**
     * Makes the pool. No connection is made before the first lookup.
     *
     * @param {IHisConfig} config - Where the HIS database is.
     */
    constructor(config: IHisConfig) {
        this._pool = createPool({
            acquireTimeout: 10_000,
            charset: 'utf8mb4',
            connectTimeout: 10_000,
            connectionLimit: 2,
            database: config.database,
            host: config.host,

            // Even a user with more rights than it should have cannot change the HIS through these connections.
            initSql: 'SET SESSION TRANSACTION READ ONLY',
            minimumIdle: 0,
            password: config.password,
            port: config.port,
            queryTimeout: 10_000,
            user: config.user
        });
    }

    /**
     * The patient's appointments on that day, the earliest first.
     *
     * @param {string} hn - The HN.
     * @param {string} date - The day, as `YYYY-MM-DD`.
     * @returns {Promise<IAppointment[]>}
     */
    async appointments(hn: string, date: string): Promise<IAppointment[]> {
        return appointmentsFrom(await this._pool.query(APPOINTMENTS_SQL, [ hn, date ]));
    }

    /**
     * Closes the pool.
     *
     * @returns {Promise<void>}
     */
    close(): Promise<void> {
        return this._pool.end();
    }
}
