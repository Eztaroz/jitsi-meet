/**
 * The audit log's entries: who asked for each move and each stage change, and what came of it. They name no
 * patient: a patient's room is referred to by a keyed reference, so that the log can be searched for one room by
 * someone who has the key, and tells nothing to anyone who has not (ADR 0005).
 */
import { createHmac } from 'node:crypto';

import type { IMove, Stage } from './patientFlow.ts';
import { backendSafeRoomName } from './roomName.ts';
import type { ILayout } from './rooms.ts';

export interface IAuditEntry {
    at: Date;

    /** A move's destination: a station's or a lounge's name, or a keyed reference. */
    destination?: string;

    /** An encounter's id. */
    encounterId?: string;
    from?: Stage;

    /** `system` for the hospital's system, or a coordinator's verified identity id. */
    issuer: string;
    kind: 'move' | 'stage';
    outcome: string;

    /** The moved participant's verified identity id. */
    participantId?: string;
    reason?: string;

    /** A move's origin: a station's or a lounge's name, or a keyed reference. */
    source?: string;
    to?: Stage;
}

/**
 * Refers to a room. A station or a lounge is named as it is; any other room is a patient's, named by their HN, and is
 * referred to by a keyed reference.
 *
 * @param {string} key - The key of the references.
 * @param {string} room - The room.
 * @param {ILayout} layout - The configured rooms.
 * @returns {string}
 */
export function auditRef(key: string, room: string, layout: ILayout): string {
    const safe = backendSafeRoomName(room);

    if ([ ...layout.stations, ...layout.lounges ].some(r => backendSafeRoomName(r.room) === safe)) {
        return room;
    }

    return `room:${createHmac('sha256', key).update(safe).digest('hex').slice(0, 16)}`;
}

/**
 * The entry of a move that has ended.
 *
 * @param {IMove} move - The move.
 * @param {Object} options - Options.
 * @param {Date} options.at - When it ended.
 * @param {string} options.issuer - Who asked.
 * @param {string} options.key - The key of the references.
 * @param {ILayout} options.layout - The configured rooms.
 * @returns {IAuditEntry}
 */
export function moveEntry(move: IMove, { at, issuer, key, layout }: {
    at: Date;
    issuer: string;
    key: string;
    layout: ILayout;
}): IAuditEntry {
    return {
        at,
        destination: auditRef(key, move.destination, layout),
        issuer,
        kind: 'move',
        outcome: move.state,
        participantId: move.identityId,
        reason: move.reason,
        source: auditRef(key, move.origin, layout)
    };
}

/**
 * The entry of a stage change.
 *
 * @param {Object} options - Options.
 * @returns {IAuditEntry}
 */
export function stageEntry({ at, encounterId, from, issuer, outcome, reason, to }: {
    at: Date;
    encounterId: string;
    from?: Stage;
    issuer: string;
    outcome: 'ok' | 'refused';
    reason?: string;
    to: Stage;
}): IAuditEntry {
    return { at, encounterId, from, issuer, kind: 'stage', outcome, reason, to };
}
