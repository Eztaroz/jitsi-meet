/**
 * Works out what the store has to write when the rules module's state moves on, so that only what changed is written.
 */
import type { IAuditEntry } from './audit.ts';
import type { IEncounter, IMove, IState } from './rules.ts';
import { type IMoveRecord, newMoveRecord } from './store.ts';

/** One write to the store. */
export type StoreChange =
    | { audit: IAuditEntry; kind: 'audit'; }
    | { encounter: IEncounter; kind: 'encounter'; }
    | { kind: 'move'; move: IMove; record: IMoveRecord; }
    | { identityId: string; kind: 'patient_room'; room: string | undefined; }
    | { identityId: string; kind: 'staff_station'; station: string | undefined; };

/**
 * Lists the writes that take the store from one state to the next, in the order they must be applied.
 *
 * The rules module never changes an encounter or a move in place, so one that is the same object as before is
 * unchanged and is not written again.
 *
 * @param {IState} prev - The state the store holds.
 * @param {IState} next - The new state.
 * @param {ReadonlyMap<string, IMoveRecord>} prevRecords - What the store holds about each move.
 * @param {ReadonlyMap<string, IMoveRecord>} nextRecords - What is to be held about each move.
 * @param {IAuditEntry[]} audit - Audit entries to add after the rest, in the same transaction.
 * @returns {StoreChange[]}
 */
export function diffState(prev: IState, next: IState, prevRecords: ReadonlyMap<string, IMoveRecord>,
        nextRecords: ReadonlyMap<string, IMoveRecord>, audit: IAuditEntry[] = []): StoreChange[] {
    const changes: StoreChange[] = [];
    const seenEncounters = new Set(prev.encounters);
    const seenMoves = new Map(prev.moves.map(m => [ m.id, m ]));

    for (const encounter of next.encounters) {
        if (!seenEncounters.has(encounter)) {
            changes.push({ encounter, kind: 'encounter' });
        }
    }
    for (const move of next.moves) {
        const record = nextRecords.get(move.id);

        if (seenMoves.get(move.id) !== move || prevRecords.get(move.id) !== record) {
            changes.push({ kind: 'move', move, record: record ?? newMoveRecord() });
        }
    }
    for (const [ identityId, room ] of Object.entries(next.patientRooms)) {
        if (prev.patientRooms[identityId] !== room) {
            changes.push({ identityId, kind: 'patient_room', room });
        }
    }
    for (const identityId of Object.keys(prev.patientRooms)) {
        if (!(identityId in next.patientRooms)) {
            changes.push({ identityId, kind: 'patient_room', room: undefined });
        }
    }
    for (const [ identityId, station ] of Object.entries(next.staffStations)) {
        if (prev.staffStations[identityId] !== station) {
            changes.push({ identityId, kind: 'staff_station', station });
        }
    }
    for (const identityId of Object.keys(prev.staffStations)) {
        if (!(identityId in next.staffStations)) {
            changes.push({ identityId, kind: 'staff_station', station: undefined });
        }
    }
    for (const entry of audit) {
        changes.push({ audit: entry, kind: 'audit' });
    }

    return changes;
}
