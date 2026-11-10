/**
 * What the service's refusals mean to a caller, and how a caller's request body is read, shared by the system's API
 * (`api.ts`) and the staff's own requests (`staffRoutes.ts`) so that the two cannot drift apart.
 */
import type { IncomingMessage } from 'node:http';

import type { IStaffStageResult, VideoRefusal } from './coordinatorService.ts';
import { HttpError, readJson } from './http.ts';
import type { IStep } from './rules.ts';

/** A refusal's HTTP status and what it says. */
export type RefusalReply = [ number, string ];

/** What each reason a stage could not be changed means to the caller. */
export const STAGE_REFUSALS: Record<NonNullable<IStaffStageResult['refused'] | IStep['refused']>, RefusalReply> = {
    'done_is_not_for_staff': [ 403, 'staff cannot close an encounter' ],
    'encounter_closed': [ 409, 'the encounter is done' ],
    'not_in_patients_room': [ 403, 'staff can only do this from the patient\'s own room' ],
    'stage_not_in_pathway': [ 400, 'the stage is not in the encounter\'s pathway' ],
    'unknown_center': [ 400, 'center is not a configured center' ],
    'unknown_clinic': [ 400, 'clinic is not a clinic of the center' ],
    'unknown_encounter': [ 404, 'no such encounter' ]
};

/** What each reason a video could not be played or stopped means to the caller. */
export const VIDEO_REFUSALS: Record<VideoRefusal, RefusalReply> = {
    'already_playing': [ 409, 'a video is already playing in the room' ],
    'encounter_closed': [ 409, 'the encounter is done' ],
    'no_video': [ 409, 'no video was asked for and the stage has no default video' ],
    'not_in_patients_room': [ 403, 'staff can only do this from the patient\'s own room' ],
    'not_playing': [ 409, 'no video is playing in the room' ],
    'stage_not_in_pathway': [ 400, 'the stage is not in the encounter\'s pathway' ],
    'unknown_encounter': [ 404, 'no such encounter' ],
    'unknown_video': [ 400, 'the video is not in the catalogue' ],
    'video_player_unavailable': [ 503, 'the video player cannot play now' ]
};

/** What each reason a questionnaire could not be sent or read means to the caller. */
export const QUESTIONNAIRE_REFUSALS: Record<
    'encounter_closed' | 'not_in_patients_room' | 'unknown_encounter' | 'unknown_questionnaire', RefusalReply> = {
    'encounter_closed': [ 409, 'the encounter is done' ],
    'not_in_patients_room': [ 403, 'staff can only do this from the patient\'s own room' ],
    'unknown_encounter': [ 404, 'no such encounter' ],
    'unknown_questionnaire': [ 400, 'questionnaire is not in the configured catalogue' ]
};

/**
 * Reads the body of a stage change.
 *
 * @param {IncomingMessage} req - The request.
 * @returns {Promise<string>} The stage.
 * @throws {HttpError} When there is no stage.
 */
export async function readStage(req: IncomingMessage): Promise<string> {
    const stage = (await readJson(req) as { stage?: unknown; } | null)?.stage;

    if (typeof stage !== 'string' || !stage) {
        throw new HttpError(400, 'stage must be a non-empty string');
    }

    return stage;
}

/**
 * Reads the body of a questionnaire to send.
 *
 * @param {IncomingMessage} req - The request.
 * @returns {Promise<string>} The questionnaire's id.
 * @throws {HttpError} When there is none.
 */
export async function readQuestionnaire(req: IncomingMessage): Promise<string> {
    const questionnaire = (await readJson(req) as { questionnaire?: unknown; } | null)?.questionnaire;

    if (typeof questionnaire !== 'string' || !questionnaire) {
        throw new HttpError(400, 'questionnaire must be a non-empty string');
    }

    return questionnaire;
}

/**
 * Reads the body of a choice of a patient's waiting video.
 *
 * @param {IncomingMessage} req - The request.
 * @returns {Promise<Object>} The stage and the video.
 * @throws {HttpError} When either is missing.
 */
export async function readVideoChoice(req: IncomingMessage): Promise<{ stage: string; video: string; }> {
    const asked = await readJson(req) as { stage?: unknown; video?: unknown; } | null;

    if (typeof asked?.stage !== 'string' || !asked.stage || typeof asked.video !== 'string' || !asked.video) {
        throw new HttpError(400, 'stage and video must be non-empty strings');
    }

    return { stage: asked.stage, video: asked.video };
}
