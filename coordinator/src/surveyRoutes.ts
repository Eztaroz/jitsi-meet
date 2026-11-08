/**
 * The satisfaction survey's route, which the page a patient lands on once they have left a room calls with the
 * patient's own token: GET says whether the page may ask, POST keeps the answers. The shared bearer secret does not
 * open it, and a staff member's token does not either.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CoordinatorService } from './coordinatorService.ts';
import { HttpError, readJson, send } from './http.ts';
import { type ICoordinatorAuth, SignInError, verifyPatient } from './screenAuth.ts';
import { parseSurvey } from './surveys.ts';

/** How long a patient waits before another survey is kept: long enough to stop a double send. */
export const SURVEY_INTERVAL_MS = 30_000;

/**
 * Creates the handler of `/survey`.
 *
 * @param {Object} options - Options.
 * @param {ICoordinatorAuth} options.auth - The hospital's issuer, with the patient marker; without it there is no
 * survey.
 * @param {CoordinatorService} options.service - The coordinator service.
 * @returns {Function}
 */
export function createSurveyRoutes({ auth, service }: { auth?: ICoordinatorAuth; service: CoordinatorService; }) {
    /** When each patient last sent a survey, by verified identity id. */
    const lastSent = new Map<string, number>();

    /**
     * Handles a request to `/survey`.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string|undefined} token - The bearer token, if there is one.
     * @returns {Promise<void>}
     */
    return async function handleSurvey(req: IncomingMessage, res: ServerResponse, token: string | undefined) {
        if (!auth || (req.method !== 'GET' && req.method !== 'POST')) {
            throw new HttpError(404, 'not found');
        }
        if (!token) {
            res.setHeader('www-authenticate', 'Bearer');
            throw new HttpError(401, 'send the patient\'s token');
        }

        let patient;

        try {
            patient = await verifyPatient(token, auth);
        } catch (error) {
            if (error instanceof SignInError) {
                send(res, 403, { error: error.code });

                return;
            }
            throw error;
        }

        if (req.method === 'GET') {
            send(res, 200, { ask: true });

            return;
        }

        const answers = parseSurvey(await readJson(req));
        const now = Date.now();

        for (const [ id, at ] of lastSent) {
            if (now - at >= SURVEY_INTERVAL_MS) {
                lastSent.delete(id);
            }
        }
        if (lastSent.has(patient.id)) {
            throw new HttpError(429, 'a survey was just sent');
        }
        lastSent.set(patient.id, now);
        send(res, 201, { id: service.addSurvey(patient.id, answers).id });
    };
}
