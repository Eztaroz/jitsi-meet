/**
 * The satisfaction survey a patient answers on the page they land on once they have left a room (static/left.html):
 * reading the answers, tying them to the patient's HN and encounter, and the report the hospital's quality department
 * exports. A survey holds an HN, so it is kept and swept like the encounters (ADR 0005).
 */
import { HttpError } from './http.ts';
import { backendSafeRoomName } from './roomName.ts';
import type { ILayout } from './rooms.ts';
import type { IState, Stage } from './rules.ts';

export const SURVEY_TAGS = [ 'picture', 'sound', 'wait', 'disconnected', 'explained', 'kind' ] as const;
export const SURVEY_ASPECTS = [ 'ease', 'quality', 'wait', 'care' ] as const;
export const MAX_COMMENT_LENGTH = 2000;
const MAX_ROOM_LENGTH = 256;

/** What stood out, picked from chips. */
export type SurveyTag = typeof SURVEY_TAGS[number];

/** A part of the service rated on its own, from 5 (very much) to 1 (very little). */
export type SurveyAspect = typeof SURVEY_ASPECTS[number];

/** The room a survey was answered after leaving: a station's name, or `own_room` for the patient's own room. */
export type SurveyRoom = string;

/** What the patient answered, and the room they left as the page reports it. */
export interface ISurveyAnswers {
    aspects: Partial<Record<SurveyAspect, number>>;
    comment?: string;

    /** The overall rating, 1 (very poor) to 5 (excellent). */
    rating: number;
    room: string;
    tags: SurveyTag[];
}

/** Where a survey belongs. */
export interface ISurveyPlace {
    encounterId?: string;
    hn?: string;

    /**
     * How the HN is known: `known` from the patient's own room as the service learned it, `reported` from the room the
     * page says the patient left.
     */
    hnSource?: 'known' | 'reported';
    room?: SurveyRoom;
    stage?: Stage;
}

/** A survey as it is kept. */
export interface ISurvey extends ISurveyPlace, Omit<ISurveyAnswers, 'room'> {
    id: string;
    submittedAt: Date;
}

/**
 * Checks a rating from 1 to 5.
 *
 * @param {unknown} value - The value.
 * @returns {boolean}
 */
function isRating(value: unknown): value is number {
    return Number.isInteger(value) && (value as number) >= 1 && (value as number) <= 5;
}

/**
 * Reads the answers of a survey.
 *
 * @param {unknown} body - The request body.
 * @returns {ISurveyAnswers}
 * @throws {HttpError} 400 when it is not a survey.
 */
export function parseSurvey(body: unknown): ISurveyAnswers {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const { aspects = {}, comment, rating, room, tags = [] } = b;

    if (!isRating(rating)) {
        throw new HttpError(400, 'rating must be an integer from 1 to 5');
    }
    if (typeof room !== 'string' || !room.trim() || room.length > MAX_ROOM_LENGTH) {
        throw new HttpError(400, 'room must be the name of the room left');
    }
    if (!Array.isArray(tags) || !tags.every(t => (SURVEY_TAGS as readonly unknown[]).includes(t))) {
        throw new HttpError(400, `tags must be a list of ${SURVEY_TAGS.join(', ')}`);
    }
    if (typeof aspects !== 'object' || aspects === null || Array.isArray(aspects)
            || !Object.entries(aspects).every(([ k, v ]) => (SURVEY_ASPECTS as readonly string[]).includes(k) && isRating(v))) {
        throw new HttpError(400, `aspects must rate ${SURVEY_ASPECTS.join(', ')} from 1 to 5`);
    }
    if (comment !== undefined && (typeof comment !== 'string' || comment.length > MAX_COMMENT_LENGTH)) {
        throw new HttpError(400, `comment must be text of at most ${MAX_COMMENT_LENGTH} characters`);
    }

    // eslint-disable-next-line no-control-regex
    const cleaned = comment?.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/gu, '').trim();

    return {
        aspects: aspects as ISurveyAnswers['aspects'],
        comment: cleaned || undefined,
        rating,
        room,
        tags: [ ...new Set(tags as SurveyTag[]) ]
    };
}

/**
 * Says whether a room name, as a page or Prosody reports it, is a room people know by a name, such as an HN.
 *
 * @param {string} reported - The room as reported: as typed, or backend safe.
 * @param {string} name - The name.
 * @returns {boolean}
 */
function sameRoom(reported: string, name: string): boolean {
    const safe = backendSafeRoomName(name);

    return backendSafeRoomName(reported) === safe || reported.toLowerCase() === safe;
}

/**
 * Ties a survey to the patient's HN and encounter. The HN comes from the patient's own room as the service learned
 * it; failing that, from the room left, when that is not a station or a lounge, as every other room is a patient's
 * room named after their HN.
 *
 * @param {Object} options - Options.
 * @param {string} options.identityId - The patient's verified identity id.
 * @param {ILayout} options.layout - The stations and lounges.
 * @param {string} options.room - The room left, as the page reports it.
 * @param {IState} options.state - The service's state.
 * @returns {ISurveyPlace}
 */
export function placeSurvey({ identityId, layout, room, state }: {
    identityId: string;
    layout: ILayout;
    room: string;
    state: IState;
}): ISurveyPlace {
    const fixed = [ ...layout.stations, ...layout.lounges ].find(r => sameRoom(room, r.room));
    const known = state.patientRooms[identityId];
    const hnRoom = known ?? (fixed ? undefined : room);
    const where = { room: fixed?.room ?? 'own_room' };

    if (!hnRoom) {
        return where;
    }

    const encounter = state.encounters
        .filter(e => sameRoom(hnRoom, e.hn))
        .sort((a, b) => b.startedAt.getTime() - a.startedAt.getTime())[0];
    const hnSource = known ? 'known' as const : 'reported' as const;

    return encounter
        ? { encounterId: encounter.id, hn: encounter.hn, hnSource, ...where, stage: encounter.stage }
        : { hn: hnRoom, hnSource, ...where };
}

const CSV_COLUMNS = [ 'submitted_at', 'hn', 'hn_source', 'encounter_id', 'stage', 'room', 'rating',
    ...SURVEY_ASPECTS, 'tags', 'comment' ];

/**
 * Writes a CSV cell: quoted when it has to be, and never read as a formula by a spreadsheet.
 *
 * @param {unknown} value - The value.
 * @returns {string}
 */
function cell(value: unknown): string {
    if (value === undefined || value === null) {
        return '';
    }

    let text = String(value);

    if (/^[=+\-@\t\r]/u.test(text)) {
        text = `'${text}`;
    }

    return /[",\r\n]/u.test(text) ? `"${text.replace(/"/gu, '""')}"` : text;
}

/**
 * Writes the survey report: CSV with a byte order mark, so that a spreadsheet reads Thai, times in the deployment's
 * time zone.
 *
 * @param {ISurvey[]} surveys - The surveys, oldest first.
 * @param {string} timeZone - The IANA time zone.
 * @returns {string}
 */
export function surveysCsv(surveys: ISurvey[], timeZone: string): string {
    // Swedish writes dates as ISO does: 2030-01-01 15:05:00.
    const time = new Intl.DateTimeFormat('sv-SE', {
        day: '2-digit', hour: '2-digit', hourCycle: 'h23', minute: '2-digit', month: '2-digit', second: '2-digit',
        timeZone, year: 'numeric'
    });
    const rows = surveys.map(s => [
        time.format(s.submittedAt), s.hn, s.hnSource, s.encounterId, s.stage, s.room, s.rating,
        ...SURVEY_ASPECTS.map(a => s.aspects[a]), s.tags.join(';'), s.comment
    ].map(cell).join(','));

    return `﻿${[ CSV_COLUMNS.join(','), ...rows ].map(row => `${row}\r\n`).join('')}`;
}
