/**
 * The NHSO (National Health Security Office) authentication of each encounter, for the claim and not for care: the
 * status never holds an encounter up (ADR 0020). On a day the NHSO API is down, a coordinator declares a bypass day:
 * NHSO then takes every visit of the day as authenticated, and the claims staff list that day's encounters.
 */
import { cell } from './surveys.ts';

/** An encounter's NHSO authentication, as the coordinator's screen shows it. */
export type NhsoStatus = 'authenticated' | 'bypassed' | 'not_yet' | 'unavailable';

/** A day a coordinator declared the NHSO API down, in the deployment's time zone. */
export interface IBypassDay {

    /** When it was cancelled, the same day; a cancelled day is no bypass day. */
    cancelledAt?: Date;

    /** Who cancelled it: a coordinator's verified identity id, or `system`. */
    cancelledBy?: string;

    /** The day, as `YYYY-MM-DD`. */
    day: string;
    declaredAt: Date;

    /** Who declared it: a coordinator's verified identity id, or `system`. */
    declaredBy: string;
}

/**
 * Asks the NHSO API whether an encounter's patient has authenticated. The API's spec is not here yet (GitLab #41): until
 * it is, no checker is configured and every status that is not a bypass is `unavailable`.
 */
export interface INhsoChecker {

    /**
     * Whether the patient has authenticated for the day. Throws when the API cannot be asked.
     *
     * @param {Object} encounter - The encounter: its HN, visit number and day.
     * @returns {Promise<boolean>}
     */
    authenticated: (encounter: { day: string; hn: string; visitNumber?: string; }) => Promise<boolean>;
}

/** An encounter of a bypass day, as the claims staff get it. */
export interface IBypassedEncounter {
    clinic?: string;
    day: IBypassDay;
    encounterId: string;
    hn: string;
    startedAt: Date;
    visitNumber?: string;
}

const CSV_COLUMNS = [ 'day', 'declared_by', 'declared_at', 'encounter_id', 'hn', 'visit_number', 'clinic', 'started_at' ];

/**
 * Returns the day of a moment in a time zone.
 *
 * @param {Date} at - The moment.
 * @param {string} timeZone - The IANA time zone.
 * @returns {string} Such as `2026-11-25`.
 */
export function dayOf(at: Date, timeZone: string): string {
    // Swedish writes dates as ISO does.
    return new Intl.DateTimeFormat('sv-SE', { day: '2-digit', month: '2-digit', timeZone, year: 'numeric' }).format(at);
}

/**
 * Whether a text is a day, as `YYYY-MM-DD`.
 *
 * @param {unknown} value - The text.
 * @returns {boolean}
 */
export function isDay(value: unknown): value is string {
    return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/u.test(value) && !Number.isNaN(Date.parse(value));
}

/**
 * Writes the list of the encounters of bypass days for the claims staff: CSV with a byte order mark, so that a
 * spreadsheet reads Thai, times in the deployment's time zone.
 *
 * @param {IBypassedEncounter[]} encounters - The encounters, by day and then the oldest first.
 * @param {string} timeZone - The IANA time zone.
 * @returns {string}
 */
export function bypassCsv(encounters: IBypassedEncounter[], timeZone: string): string {
    const time = new Intl.DateTimeFormat('sv-SE', {
        day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', second: '2-digit',
        timeZone, year: 'numeric'
    });
    const rows = encounters.map(e => [
        e.day.day, e.day.declaredBy, time.format(e.day.declaredAt), e.encounterId, e.hn, e.visitNumber, e.clinic,
        time.format(e.startedAt)
    ].map(cell).join(','));

    return `﻿${[ CSV_COLUMNS.join(','), ...rows ].map(row => `${row}\r\n`).join('')}`;
}
