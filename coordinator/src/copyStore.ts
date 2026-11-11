/**
 * Copies everything one store holds into another: the one-off move of a deployment from SQLite to MariaDB (ADR 0015).
 */
import type { IStore } from './store.ts';

/** How many writes go in one transaction. */
const BATCH = 500;

/** Later than any survey: ISO 8601 text compares as text only up to the year 9999. */
const FAR_FUTURE = new Date('9999-12-31T23:59:59.999Z');

/** How many of each were copied. */
export interface ICopyCounts {
    audit: number;
    consultations: number;
    encounters: number;
    moves: number;
    surveys: number;
}

/**
 * Copies every encounter, move, audit entry, survey and consultation, and the patients' rooms and staff's stations,
 * from a store into an empty one. It refuses a target that already holds something, so that running it twice does not
 * write the audit log twice.
 *
 * @param {IStore} source - The store to copy from.
 * @param {IStore} target - The store to copy into.
 * @returns {ICopyCounts}
 */
export function copyStore(source: IStore, target: IStore): ICopyCounts {
    const held = target.load();

    if (held.encounters.length || held.moves.length || target.audit(1).length || target.allConsultations().length
            || target.surveys(new Date(0), FAR_FUTURE).length) {
        throw new Error('the target database already holds encounters, moves, audit entries, surveys or consultations');
    }

    const state = source.load();
    const records = source.loadMoveRecords();
    const consultations = source.allConsultations();
    const surveys = source.surveys(new Date(0), FAR_FUTURE);

    // The newest first is what the store gives; the audit log is written oldest first, to keep its order.
    const audit = source.audit(Number.MAX_SAFE_INTEGER).reverse();

    target.apply([
        ...state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })),
        ...state.moves.map(move => ({ kind: 'move' as const, move, record: records.get(move.id) as never })),
        ...consultations.map(consultation => ({ consultation, kind: 'consultation' as const })),
        ...Object.entries(state.patientRooms).map(([ identityId, room ]) => ({ identityId, kind: 'patient_room' as const, room })),
        ...Object.entries(state.staffStations).map(([ identityId, station ]) => ({ identityId, kind: 'staff_station' as const, station }))
    ]);

    for (let i = 0; i < audit.length; i += BATCH) {
        target.apply(audit.slice(i, i + BATCH).map(entry => ({ audit: entry, kind: 'audit' as const })));
    }
    for (const survey of surveys) {
        target.addSurvey(survey);
    }

    return {
        audit: audit.length,
        consultations: consultations.length,
        encounters: state.encounters.length,
        moves: state.moves.length,
        surveys: surveys.length
    };
}
