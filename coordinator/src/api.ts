/**
 * The coordinator service's API. The hospital's system calls it with the shared bearer secret, on the internal
 * network only. Encounters are identified by an opaque id; an HN appears only in the request that starts one and in
 * what is read back.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import type { CoordinatorService, VideoRefusal } from './coordinatorService.ts';
import { HttpError, readJson, send } from './http.ts';
import { errorCode, log } from './log.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { createQuestionnaireRoutes } from './questionnaireRoutes.ts';
import { describeSent } from './questionnaires.ts';
import { RecorderBotUnavailableError } from './recorderBot.ts';
import {
    QUESTIONNAIRE_REFUSALS,
    STAGE_REFUSALS,
    VIDEO_REFUSALS,
    readQuestionnaire,
    readStage,
    readVideoChoice
} from './refusals.ts';
import type { IMove } from './rules.ts';
import type { ICoordinatorAuth } from './screenAuth.ts';
import { createScreenRoutes } from './screenRoutes.ts';
import { createStaffRoutes } from './staffRoutes.ts';
import { createSurveyRoutes } from './surveyRoutes.ts';

/** Who the audit log names for a call with the shared bearer secret. */
const SYSTEM = 'system';
const MAX_HN_LENGTH = 128;

/** The period of a survey report without one. */
const DEFAULT_REPORT_DAYS = 30;

/**
 * Compares two secrets in constant time.
 *
 * @param {string} a - One secret.
 * @param {string} b - The other.
 * @returns {boolean}
 */
function sameSecret(a: string, b: string): boolean {
    const digest = (s: string) => createHash('sha256').update(s).digest();

    return timingSafeEqual(digest(a), digest(b));
}

/**
 * Checks the HN of a request.
 *
 * @param {unknown} body - The request body.
 * @returns {string} The HN.
 */
function hnFrom(body: unknown): string {
    const hn = typeof body === 'object' && body !== null ? (body as { hn?: unknown; }).hn : undefined;

    if (typeof hn !== 'string' || !hn.trim()) {
        throw new HttpError(400, 'hn must be a non-empty string');
    }
    if (hn.length > MAX_HN_LENGTH) {
        throw new HttpError(400, `hn must be at most ${MAX_HN_LENGTH} characters`);
    }

    // eslint-disable-next-line no-control-regex
    if (/[\u0000-\u001f\u007f]/.test(hn)) {
        throw new HttpError(400, 'hn is not usable');
    }

    return hn;
}

/**
 * Reads the optional parts of a request that starts an encounter: the visit number, center and clinic.
 *
 * @param {unknown} body - The request body.
 * @returns {Object}
 */
function attendanceFrom(body: unknown): { center?: string; clinic?: string; visitNumber?: string; } {
    const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
    const result: { center?: string; clinic?: string; visitNumber?: string; } = {};

    for (const key of [ 'center', 'clinic', 'visitNumber' ] as const) {
        const value = b[key];

        if (value === undefined) {
            continue;
        }
        // eslint-disable-next-line no-control-regex
        if (typeof value !== 'string' || !value.trim() || value.length > MAX_HN_LENGTH || /[\u0000-\u001f\u007f]/.test(value)) {
            throw new HttpError(400, `${key} must be a non-empty string of at most ${MAX_HN_LENGTH} characters`);
        }
        result[key] = value;
    }

    return result;
}

/**
 * Describes an encounter for the API; the HN is only in what is read, never in the id. A stage of the history is
 * named by the pathway, or by its id when the configuration no longer has it.
 *
 * @param {CoordinatorService} service - The coordinator service.
 * @param {string} id - The encounter's id.
 * @returns {Object}
 */
function encounterBody(service: CoordinatorService, id: string) {
    const e = service.describeEncounter(id);

    if (!e) {
        throw new HttpError(404, 'no such encounter');
    }

    return {
        center: e.center,
        clinic: e.clinic,
        doctor: e.doctor,
        history: e.history,
        hn: e.hn,
        id: e.id,
        pathway: e.pathway,
        stage: e.stage,
        stageName: e.stageName,
        stageStartedAt: e.stageStartedAt,
        startedAt: e.startedAt,
        unfinished: e.unfinished,
        visitNumber: e.visitNumber
    };
}

/**
 * Describes a move for the API.
 *
 * @param {IMove} move - The move.
 * @returns {Object}
 */
function moveBody(move: IMove) {
    return { id: move.id, reason: move.reason, state: move.state };
}

/**
 * Reads a move request: who to move, and to which room.
 *
 * @param {unknown} body - The request body.
 * @returns {Object}
 */
function moveFrom(body: unknown): { endpointId: string; fromRoom: string; toRoom: string; } {
    const b = body as { from?: { endpointId?: unknown; room?: unknown; }; to?: { room?: unknown; }; } | null;
    const endpointId = b?.from?.endpointId;
    const fromRoom = b?.from?.room;
    const toRoom = b?.to?.room;

    if (typeof endpointId !== 'string' || typeof fromRoom !== 'string' || typeof toRoom !== 'string'
            || !endpointId || !fromRoom || !toRoom) {
        throw new HttpError(400, 'from.room, from.endpointId and to.room must be non-empty strings');
    }

    return { endpointId, fromRoom, toRoom };
}

/**
 * Reads a time of a report's period: ISO 8601, such as `2030-01-01T00:00:00+07:00`.
 *
 * @param {string|null} value - The query parameter.
 * @param {Date} fallback - The time without it.
 * @returns {Date}
 */
function reportTime(value: string | null, fallback: Date): Date {
    if (value === null) {
        return fallback;
    }

    const time = /^\d{4}-\d{2}-\d{2}(T[\d:.]+(Z|[+-]\d{2}:\d{2})?)?$/u.test(value) ? new Date(value) : undefined;

    if (!time || Number.isNaN(time.getTime())) {
        throw new HttpError(400, 'from and to must be ISO 8601 times, such as 2030-01-01T00:00:00+07:00');
    }

    return time;
}

/**
 * Creates the API server.
 *
 * @param {Object} options - Options.
 * @param {CoordinatorService} options.service - The coordinator service.
 * @param {ICoordinatorAuth} options.screen - How coordinators sign in; without it there is no screen.
 * @param {string} options.secret - The shared bearer secret.
 * @param {ICoordinatorAuth} options.survey - The hospital's issuer with the patient marker, which a patient's token
 * must match to send a satisfaction survey; without it there is no survey.
 * @returns {Server}
 */
export function createApi({ screen, secret, service, staff, survey }: {
    screen?: ICoordinatorAuth;
    secret: string;
    service: CoordinatorService;
    staff?: ICoordinatorAuth;
    survey?: ICoordinatorAuth;
}): Server {
    /**
     * Handles the requests that act: starting an encounter, moving a participant and changing a stage. The system and
     * the coordinators' screen make the same ones, and the audit log names who made them.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string} pathname - The path, without the screen's prefix.
     * @param {string} issuer - Who asks: `system`, or a coordinator's verified identity id.
     * @returns {Promise<boolean>} Whether it was one of them, and answered.
     */
    async function act(req: IncomingMessage, res: ServerResponse, pathname: string, issuer: string): Promise<boolean> {
        if (pathname === '/encounters' && req.method === 'POST') {
            const body = await readJson(req);
            const hn = hnFrom(body);
            const attendance = attendanceFrom(body);

            try {
                const { encounter, refused } = await service.startEncounter(hn, attendance);

                if (refused === 'unknown_center' || refused === 'unknown_clinic') {
                    throw new HttpError(400, refused === 'unknown_center'
                        ? 'center is not a configured center' : 'clinic is not a clinic of the center');
                }
                send(res, encounter?.created ? 201 : 200,
                    { id: encounter?.id, stage: encounter?.stage, startedAt: encounter?.startedAt });
            } catch (error) {
                if (error instanceof RecorderBotUnavailableError) {
                    log.warn('could not start an encounter', { error: error.code });
                    throw new HttpError(503, `the recorder bot cannot record the room now (${error.code})`);
                }
                throw error;
            }

            return true;
        }
        if (pathname === '/moves' && req.method === 'POST') {
            const request = moveFrom(await readJson(req));

            try {
                const move = await service.requestMove(request, issuer);

                send(res, move.state === 'refused' ? 200 : 202, moveBody(move));
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not send a move', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return true;
        }

        const questionnaireMatch = /^\/encounters\/([^/]+)\/questionnaires$/.exec(pathname);

        if (questionnaireMatch && req.method === 'POST') {
            const questionnaire = await readQuestionnaire(req);

            try {
                const { refused, sent } = await service.sendQuestionnaire(
                    decodeURIComponent(questionnaireMatch[1]), questionnaire, issuer);

                if (refused) {
                    throw new HttpError(...QUESTIONNAIRE_REFUSALS[refused]);
                }
                send(res, 201, { id: sent?.id });
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not send a questionnaire', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return true;
        }

        const stageMatch = /^\/encounters\/([^/]+)\/stage$/.exec(pathname);

        if (stageMatch && req.method === 'POST') {
            const stage = await readStage(req);
            const { encounter, refused } = await service.changeStage(decodeURIComponent(stageMatch[1]), stage, issuer);

            if (refused) {
                throw new HttpError(...STAGE_REFUSALS[refused]);
            }
            send(res, 200, encounterBody(service, encounter?.id as string));

            return true;
        }

        const doctorMatch = /^\/encounters\/([^/]+)\/doctor$/.exec(pathname);

        if (doctorMatch && req.method === 'POST') {
            const doctor = (await readJson(req) as { doctor?: unknown; } | null)?.doctor;

            // eslint-disable-next-line no-control-regex
            const hasControl = typeof doctor === 'string' && /[\x00-\x1f\x7f]/.test(doctor);

            if (doctor !== null && (typeof doctor !== 'string' || !doctor.trim() || doctor.length > MAX_HN_LENGTH
                    || hasControl)) {
                throw new HttpError(400, `doctor must be a non-empty string of at most ${MAX_HN_LENGTH} characters, or null`);
            }

            const { encounter, refused } = await service.setDoctor(decodeURIComponent(doctorMatch[1]), doctor, issuer);

            if (refused === 'unknown_encounter') {
                throw new HttpError(404, 'no such encounter');
            }
            if (refused === 'encounter_closed') {
                throw new HttpError(409, 'the encounter is done');
            }
            send(res, 200, encounterBody(service, encounter?.id as string));

            return true;
        }

        const choiceMatch = /^\/encounters\/([^/]+)\/video-choice$/.exec(pathname);

        if (choiceMatch && req.method === 'POST') {
            const asked = await readVideoChoice(req);
            const { refused } = await service.setVideo(decodeURIComponent(choiceMatch[1]), asked.stage, asked.video, issuer);

            if (refused) {
                throw new HttpError(...VIDEO_REFUSALS[refused]);
            }
            send(res, 200, { stage: asked.stage, video: asked.video });

            return true;
        }

        const videoMatch = /^\/encounters\/([^/]+)\/video(\/stop)?$/.exec(pathname);

        if (videoMatch && req.method === 'POST') {
            const encounterId = decodeURIComponent(videoMatch[1]);
            let refused: VideoRefusal | undefined;
            let video: string | undefined;

            if (videoMatch[2]) {
                ({ refused } = await service.stopVideo(encounterId, issuer));
            } else {
                const asked = (await readJson(req) as { video?: unknown; } | null)?.video;

                if (asked !== undefined && (typeof asked !== 'string' || !asked)) {
                    throw new HttpError(400, 'video must be a non-empty string');
                }
                ({ refused, video } = await service.playVideo(encounterId, issuer, asked));
            }
            if (refused) {
                throw new HttpError(...VIDEO_REFUSALS[refused]);
            }
            send(res, 200, { video });

            return true;
        }

        return false;
    }

    const handleScreen = createScreenRoutes({ act, screen, service });
    const handleSurvey = createSurveyRoutes({ auth: survey, service });
    const handleStaff = createStaffRoutes({ auth: staff, service });

    // The patient's client answers a questionnaire with the same patient token as the survey.
    const handleQuestionnaire = createQuestionnaireRoutes({ auth: survey, service });

    /**
     * Handles one request.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @returns {Promise<void>}
     */
    async function handle(req: IncomingMessage, res: ServerResponse) {
        const [ scheme, token ] = (req.headers.authorization ?? '').split(' ');

        const path = new URL(req.url ?? '/', 'http://localhost').pathname;

        if (path.startsWith('/screen')) {
            await handleScreen(req, res, scheme === 'Bearer' ? token : undefined);

            return;
        }
        if (path === '/questionnaire') {
            await handleQuestionnaire(req, res, scheme === 'Bearer' ? token : undefined);

            return;
        }
        if (path === '/staff' || path.startsWith('/staff/')) {
            await handleStaff(req, res, scheme === 'Bearer' ? token : undefined);

            return;
        }
        if (path === '/survey') {
            await handleSurvey(req, res, scheme === 'Bearer' ? token : undefined);

            return;
        }

        if (scheme !== 'Bearer' || !token || !sameSecret(token, secret)) {
            res.setHeader('www-authenticate', 'Bearer');
            throw new HttpError(401, 'missing or wrong bearer secret');
        }

        const { pathname } = new URL(req.url ?? '/', 'http://localhost');

        if (pathname === '/health' && req.method === 'GET') {
            send(res, 200, {
                openEncounters: service.state.encounters.filter(e => e.stage !== 'done').length,
                status: 'ok'
            });

            return;
        }
        if (await act(req, res, pathname, SYSTEM)) {
            return;
        }
        if (pathname === '/rooms' && req.method === 'GET') {
            try {
                send(res, 200, { rooms: await service.rooms() });
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not read the rooms', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return;
        }
        if (pathname === '/audit' && req.method === 'GET') {
            const limit = Math.min(Number(new URL(req.url ?? '/', 'http://localhost').searchParams.get('limit')) || 100, 1000);

            send(res, 200, { entries: service.audit(limit) });

            return;
        }
        if (pathname === '/surveys.csv' && req.method === 'GET') {
            const query = new URL(req.url ?? '/', 'http://localhost').searchParams;
            const to = reportTime(query.get('to'), new Date());
            const from = reportTime(query.get('from'), new Date(to.getTime() - (DEFAULT_REPORT_DAYS * 24 * 60 * 60 * 1000)));

            res.writeHead(200, {
                'cache-control': 'no-store',
                'content-disposition': 'attachment; filename="surveys.csv"',
                'content-type': 'text/csv; charset=utf-8'
            });
            res.end(service.surveyReport(from, to, SYSTEM));

            return;
        }
        if (pathname === '/queues' && req.method === 'GET') {
            const queues = service.queues();
            const hnOf = (id: string) => service.state.encounters.find(e => e.id === id)?.hn;

            send(res, 200, {
                examination: service.examinationQueues(),
                queues: Object.fromEntries(Object.entries(queues).map(([ stage, entries ]) =>
                    [ stage, entries.map(e => ({ ...e, hn: hnOf(e.encounterId) })) ]))
            });

            return;
        }

        if (pathname === '/questionnaires' && req.method === 'GET') {
            send(res, 200, { questionnaires: service.questionnaireCatalogue() });

            return;
        }

        const answersMatch = /^\/encounters\/([^/]+)\/questionnaires$/.exec(pathname);

        if (answersMatch && req.method === 'GET') {
            const sent = service.questionnairesOf(decodeURIComponent(answersMatch[1]));

            if (!sent) {
                throw new HttpError(404, 'no such encounter');
            }
            send(res, 200, { questionnaires: sent.map(describeSent) });

            return;
        }

        const encounterMatch = /^\/encounters\/([^/]+)$/.exec(pathname);

        if (encounterMatch && req.method === 'GET') {
            send(res, 200, encounterBody(service, decodeURIComponent(encounterMatch[1])));

            return;
        }

        const moveMatch = /^\/moves\/([^/]+)$/.exec(pathname);

        if (moveMatch && req.method === 'GET') {
            const move = service.state.moves.find(m => m.id === decodeURIComponent(moveMatch[1]));

            if (!move) {
                throw new HttpError(404, 'no such move');
            }
            send(res, 200, moveBody(move));

            return;
        }

        throw new HttpError(404, 'not found');
    }

    return createServer((req, res) => {
        handle(req, res).catch(error => {
            if (error instanceof HttpError) {
                send(res, error.status, { error: error.message });
            } else {
                log.error('API request failed', { error: errorCode(error) });
                send(res, 500, { error: 'internal error' });
            }
        });
    });
}
