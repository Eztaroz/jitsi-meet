/**
 * The health questionnaire's route, which the patient's client calls with the patient's own token while they are in
 * their room: GET says what is waiting for them, POST keeps their answers. The shared bearer secret does not open it,
 * and a staff member's token does not either.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CoordinatorService } from './coordinatorService.ts';
import { HttpError, readJson, send } from './http.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { type ICoordinatorAuth, SignInError, verifyPatient } from './screenAuth.ts';

/**
 * Creates the handler of `/questionnaire`.
 *
 * @param {Object} options - Options.
 * @param {ICoordinatorAuth} options.auth - The hospital's issuer, with the patient marker; without it there is no
 * questionnaire.
 * @param {CoordinatorService} options.service - The coordinator service.
 * @returns {Function}
 */
export function createQuestionnaireRoutes({ auth, service }: { auth?: ICoordinatorAuth; service: CoordinatorService; }) {
    /**
     * Handles a request to `/questionnaire`.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string|undefined} token - The bearer token, if there is one.
     * @returns {Promise<void>}
     */
    return async function handleQuestionnaire(req: IncomingMessage, res: ServerResponse, token: string | undefined) {
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

        try {
            if (req.method === 'GET') {
                send(res, 200, { questionnaire: await service.pendingQuestionnaire(patient.id) ?? null });

                return;
            }

            const body = await readJson(req) as { answers?: unknown; id?: unknown; } | null;

            if (typeof body?.id !== 'string' || !body.id) {
                throw new HttpError(400, 'id must be a non-empty string');
            }

            const { refused } = await service.answerQuestionnaire(patient.id, body.id, body.answers);

            if (refused === 'unknown_questionnaire') {
                throw new HttpError(404, 'no such questionnaire is waiting for you');
            }
            if (refused === 'invalid_answers') {
                throw new HttpError(400, 'answers must be 0 or 1 for each question');
            }
            send(res, 200, {});
        } catch (error) {
            if (error instanceof ProsodyUnavailableError) {
                throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
            }
            throw error;
        }
    };
}
