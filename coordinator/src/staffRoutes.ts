/**
 * The staff's own requests (ADR 0012), under `/staff`. A staff member calls them from the call with the token of their
 * own login, from the hospital's issuer, that carries the staff role marker. The shared bearer secret does not open
 * them, and neither does a coordinator's or a patient's token: the audit log must say which staff member acted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CoordinatorService, VideoRefusal } from './coordinatorService.ts';
import { HttpError, send } from './http.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { describeSent } from './questionnaires.ts';
import {
    QUESTIONNAIRE_REFUSALS,
    STAGE_REFUSALS,
    VIDEO_REFUSALS,
    readQuestionnaire,
    readStage,
    readVideoChoice
} from './refusals.ts';
import { type ICoordinator, type ICoordinatorAuth, SignInError, verifyStaff } from './screenAuth.ts';

/**
 * Creates the handler of the requests under `/staff`. Further staff actions go in its `route` function, which has the
 * verified staff member.
 *
 * @param {Object} options - Options.
 * @param {ICoordinatorAuth} options.auth - The hospital's issuer, with the staff marker; without it there are no staff
 * requests.
 * @param {CoordinatorService} options.service - The coordinator service.
 * @returns {Function}
 */
export function createStaffRoutes({ auth, service }: { auth?: ICoordinatorAuth; service: CoordinatorService; }) {
    /**
     * Handles a staff member's request.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string} path - The path, without `/staff`.
     * @param {ICoordinator} staff - The verified staff member.
     * @returns {Promise<void>}
     */
    async function route(req: IncomingMessage, res: ServerResponse, path: string, staff: ICoordinator): Promise<void> {
        if (path === '/me' && req.method === 'GET') {
            send(res, 200, await service.staffContext(staff));

            return;
        }

        if (path === '/next' && req.method === 'POST') {
            const result = await service.staffCallNext(staff);

            if (result.refused) {
                send(res, result.refused === 'queue_empty' ? 409 : 403, { error: result.refused });

                return;
            }
            send(res, 200, { encounterId: result.encounterId, moved: result.moved });

            return;
        }

        const stageMatch = /^\/encounters\/([^/]+)\/stage$/u.exec(path);

        if (stageMatch && req.method === 'POST') {
            const stage = await readStage(req);
            const result = await service.staffChangeStage(decodeURIComponent(stageMatch[1]), stage, staff);

            if (result.refused) {
                send(res, STAGE_REFUSALS[result.refused][0], { error: result.refused });

                return;
            }
            send(res, 200, {
                moved: result.moved,
                stage: result.encounter?.stage
            });

            return;
        }

        const videoMatch = /^\/encounters\/([^/]+)\/(video-choice|video|video\/stop)$/u.exec(path);

        if (videoMatch && req.method === 'POST') {
            const encounterId = decodeURIComponent(videoMatch[1]);
            let result: { refused?: VideoRefusal; video?: string; };

            if (videoMatch[2] === 'video-choice') {
                const asked = await readVideoChoice(req);

                result = await service.staffSetVideo(encounterId, asked.stage, asked.video, staff);
            } else if (videoMatch[2] === 'video') {
                result = await service.staffPlayVideo(encounterId, staff);
            } else {
                result = await service.staffStopVideo(encounterId, staff);
            }
            if (result.refused) {
                send(res, VIDEO_REFUSALS[result.refused][0], { error: result.refused });

                return;
            }
            send(res, 200, { video: result.video });

            return;
        }

        const questionnairesMatch = /^\/encounters\/([^/]+)\/questionnaires$/u.exec(path);

        if (questionnairesMatch && req.method === 'POST') {
            const questionnaire = await readQuestionnaire(req);
            const { refused, sent } = await service.staffSendQuestionnaire(
                decodeURIComponent(questionnairesMatch[1]), questionnaire, staff);

            if (refused) {
                send(res, QUESTIONNAIRE_REFUSALS[refused][0], { error: refused });

                return;
            }
            send(res, 201, { id: sent?.id });

            return;
        }

        if (questionnairesMatch && req.method === 'GET') {
            const { questionnaires, refused } = await service.staffQuestionnairesOf(
                decodeURIComponent(questionnairesMatch[1]), staff);

            if (refused) {
                send(res, QUESTIONNAIRE_REFUSALS[refused][0], { error: refused });

                return;
            }
            send(res, 200, { questionnaires: (questionnaires ?? []).map(describeSent) });

            return;
        }

        throw new HttpError(404, 'not found');
    }

    /**
     * Handles a request under `/staff`.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string|undefined} token - The bearer token, if there is one.
     * @returns {Promise<void>}
     */
    return async function handleStaff(req: IncomingMessage, res: ServerResponse, token: string | undefined) {
        if (!auth) {
            throw new HttpError(404, 'not found');
        }
        if (!token) {
            res.setHeader('www-authenticate', 'Bearer');
            throw new HttpError(401, 'send the staff member\'s token');
        }

        let staff: ICoordinator;

        try {
            staff = await verifyStaff(token, auth);
        } catch (error) {
            if (error instanceof SignInError) {
                send(res, 403, { error: error.code });

                return;
            }
            throw error;
        }

        try {
            await route(req, res, new URL(req.url ?? '/', 'http://localhost').pathname.slice('/staff'.length), staff);
        } catch (error) {
            if (error instanceof ProsodyUnavailableError) {
                throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
            }
            throw error;
        }
    };
}
