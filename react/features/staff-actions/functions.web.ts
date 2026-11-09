import { IReduxState } from '../app/types';

import { IStaffContext } from './types';

/** Session storage: the staff member's own hospital-issued JWT, and the destination JWT of the move that left it. */
const HOSPITAL_JWT_KEY = 'staffHospitalJwt';
const DESTINATION_JWT_KEY = 'staffDestinationJwt';

/**
 * Keeps the staff member's own JWT across a move. A move enters the next room with a short-lived token that the
 * coordinator service signed, which the service does not take for the staff member's own, so the one the page was
 * opened with is kept in the tab's session storage until the staff member signs in again. Call it just before leaving
 * for the destination.
 *
 * @param {string|undefined} currentJwt - The JWT of the page that is leaving.
 * @param {string} destinationJwt - The JWT of the destination.
 * @returns {void}
 */
export function rememberHospitalJwt(currentJwt: string | undefined, destinationJwt: string): void {
    try {
        // A JWT that is not the previous move's destination token was issued by the hospital: it is the staff member's.
        if (currentJwt && currentJwt !== window.sessionStorage.getItem(DESTINATION_JWT_KEY)) {
            window.sessionStorage.setItem(HOSPITAL_JWT_KEY, currentJwt);
        }
        window.sessionStorage.setItem(DESTINATION_JWT_KEY, destinationJwt);
    } catch {
        // Without session storage the staff member's requests from a moved page are refused.
    }
}

/**
 * The JWT that proves who the staff member is: the page's own, or the one kept across moves.
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {string}
 */
function staffJwt(state: IReduxState): string {
    const jwt = state['features/base/jwt'].jwt ?? '';

    try {
        if (jwt && jwt === window.sessionStorage.getItem(DESTINATION_JWT_KEY)) {
            return window.sessionStorage.getItem(HOSPITAL_JWT_KEY) ?? jwt;
        }
    } catch {
        // Falls back to the page's JWT.
    }

    return jwt;
}

/**
 * The staff member's own requests to the coordinator service (ADR 0012). Every one carries the staff member's own
 * hospital-issued JWT, which the service verifies and which must carry the staff marker. This is the client entry
 * point that the staff's other actions (call next, video, questionnaire) build on.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} route - The path under `/staff`, starting with "/".
 * @param {RequestInit} init - Request options.
 * @returns {Promise<Response>}
 */
export function callStaffApi(state: IReduxState, route: string, init: RequestInit = {}): Promise<Response> {
    const base = (state['features/base/config'].staffApiUrl ?? '/coordinator').replace(/\/+$/, '');

    return fetch(`${base}/staff${route}`, {
        ...init,
        headers: { 'Authorization': `Bearer ${staffJwt(state)}`, 'Content-Type': 'application/json' }
    });
}

/**
 * Asks where the staff member is. Resolves to undefined when the service does not take the participant for staff, or
 * cannot be reached: the client then shows nothing.
 *
 * @param {IReduxState} state - The Redux state.
 * @returns {Promise<IStaffContext|undefined>}
 */
export async function fetchStaffContext(state: IReduxState): Promise<IStaffContext | undefined> {
    if (!state['features/base/jwt'].jwt) {
        return undefined;
    }

    try {
        const response = await callStaffApi(state, '/me');

        return response.ok ? await response.json() as IStaffContext : undefined;
    } catch {
        return undefined;
    }
}

/**
 * Puts the patient's encounter in a stage. The service moves the staff member back to their lounge afterwards.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} encounterId - The encounter.
 * @param {string} stage - The stage id.
 * @returns {Promise<string|undefined>} The reason when the service refused or could not be reached; undefined on success.
 */
export async function changeStage(state: IReduxState, encounterId: string, stage: string): Promise<string | undefined> {
    try {
        const response = await callStaffApi(state, `/encounters/${encodeURIComponent(encounterId)}/stage`, {
            body: JSON.stringify({ stage }),
            method: 'POST'
        });

        if (response.ok) {
            return undefined;
        }

        return (await response.json() as { error?: string; }).error ?? 'failed';
    } catch {
        return 'unreachable';
    }
}

/**
 * Sends one of the staff member's video requests for the patient's encounter.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} encounterId - The encounter.
 * @param {string} route - The path after the encounter: `/video`, `/video/stop` or `/video-choice`.
 * @param {Object} [body] - The JSON body.
 * @returns {Promise<string|undefined>} The reason when the service refused or could not be reached; undefined on success.
 */
async function videoRequest(state: IReduxState, encounterId: string, route: string, body: object = {}): Promise<string | undefined> {
    try {
        const response = await callStaffApi(state, `/encounters/${encodeURIComponent(encounterId)}${route}`, {
            body: JSON.stringify(body),
            method: 'POST'
        });

        if (response.ok) {
            return undefined;
        }

        return (await response.json() as { error?: string; }).error ?? 'failed';
    } catch {
        return 'unreachable';
    }
}

/**
 * Chooses the waiting video the patient gets at a stage, in place of the stage's default.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} encounterId - The encounter.
 * @param {string} stage - The stage id.
 * @param {string} video - The video id.
 * @returns {Promise<string|undefined>} The reason it failed, or undefined.
 */
export function chooseVideo(state: IReduxState, encounterId: string, stage: string, video: string) {
    return videoRequest(state, encounterId, '/video-choice', { stage, video });
}

/**
 * Plays the patient's video for their current stage. It keeps playing after the staff member leaves.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} encounterId - The encounter.
 * @returns {Promise<string|undefined>} The reason it failed, or undefined.
 */
export function playVideo(state: IReduxState, encounterId: string) {
    return videoRequest(state, encounterId, '/video');
}

/**
 * Stops the video playing in the patient's room.
 *
 * @param {IReduxState} state - The Redux state.
 * @param {string} encounterId - The encounter.
 * @returns {Promise<string|undefined>} The reason it failed, or undefined.
 */
export function stopVideo(state: IReduxState, encounterId: string) {
    return videoRequest(state, encounterId, '/video/stop');
}
