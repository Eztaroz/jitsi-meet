/**
 * The staff's own requests (ADR 0012), under `/staff`. A staff member calls them from the call with the token of their
 * own login, from the hospital's issuer, that carries the staff role marker. The shared bearer secret does not open
 * them, and neither does a coordinator's or a patient's token: the audit log must say which staff member acted.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CoordinatorService, IStaffStageResult } from './coordinatorService.ts';
import { HttpError, readJson, send } from './http.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { type ICoordinator, type ICoordinatorAuth, SignInError, verifyStaff } from './screenAuth.ts';

/** The status of each refusal of a staff member's stage change. */
const REFUSAL_STATUS: Record<NonNullable<IStaffStageResult['refused']>, number> = {
    done_is_not_for_staff: 403,
    encounter_closed: 409,
    not_in_patients_room: 403,
    stage_not_in_pathway: 400,
    unknown_encounter: 404
};

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
            const stage = (await readJson(req) as { stage?: unknown; } | null)?.stage;

            if (typeof stage !== 'string' || !stage) {
                throw new HttpError(400, 'stage must be a non-empty string');
            }

            const result = await service.staffChangeStage(decodeURIComponent(stageMatch[1]), stage, staff);

            if (result.refused) {
                send(res, REFUSAL_STATUS[result.refused], { error: result.refused });

                return;
            }
            send(res, 200, {
                moved: result.moved,
                stage: result.encounter?.stage
            });

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
