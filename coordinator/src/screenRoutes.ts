/**
 * The coordinator's screen: the page and its files, and the API behind it, which a coordinator's token opens.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { stripTypeScriptTypes } from 'node:module';

import type { CoordinatorService } from './coordinatorService.ts';
import { HttpError, send } from './http.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { describeSent } from './questionnaires.ts';
import { type ICoordinatorAuth, SignInError, verifyCoordinator } from './screenAuth.ts';

/** The files of the coordinator screen, read once. */
const SCREEN_FILES: Record<string, { body: Buffer; type: string; }> = {};

for (const [ route, file, type ] of [
    [ '/screen', 'index.html', 'text/html; charset=utf-8' ],
    [ '/screen/screen.css', 'screen.css', 'text/css; charset=utf-8' ],

    // The typeface, subset to Thai and Latin; its licence is fonts/OFL.txt.
    ...[ 'Regular', 'Medium', 'SemiBold', 'Bold' ].map(weight =>
        [ `/screen/fonts/Niramit-${weight}.woff2`, `fonts/Niramit-${weight}.woff2`, 'font/woff2' ])
]) {
    SCREEN_FILES[route] = { body: readFileSync(new URL(`./screen/${file}`, import.meta.url)), type };
}

// The screen's script is TypeScript; browsers get it as JavaScript, with its types stripped once, here.
SCREEN_FILES['/screen/screen.js'] = {
    body: Buffer.from(stripTypeScriptTypes(readFileSync(new URL('./screen/screen.ts', import.meta.url), 'utf8'))),
    type: 'text/javascript; charset=utf-8'
};

/**
 * Adds to a queue entry what the screen shows of its encounter. The hospital system's queues do not carry it.
 *
 * @param {CoordinatorService} service - The coordinator service.
 * @param {Object} entry - An entry of a stage's queue, or of one of examination's queues.
 * @returns {Object}
 */
function screenEntry<T extends { encounterId: string; }>(service: CoordinatorService, entry: T) {
    const encounter = service.state.encounters.find(e => e.id === entry.encounterId);

    return {
        ...entry,
        clinic: encounter?.clinic,
        doctor: encounter?.doctor,
        history: encounter?.history,
        hn: encounter?.hn,

        // Where the encounter can go: its next stage is not the next column when its pathway skips one.
        pathwayStages: service.pathwayStages(encounter?.pathway ?? ''),
        startedAt: encounter?.startedAt
    };
}

/**
 * Creates the handler of the requests under `/screen`.
 *
 * @param {Object} options - Options.
 * @param {Function} options.act - Handles the requests that act; shared with the hospital system's routes.
 * @param {CoordinatorService} options.service - The coordinator service.
 * @param {ICoordinatorAuth} options.screen - How coordinators sign in; without it there is no screen.
 * @returns {Function}
 */
export function createScreenRoutes({ act, screen, service }: {
    act: (req: IncomingMessage, res: ServerResponse, pathname: string, issuer: string) => Promise<boolean>;
    screen?: ICoordinatorAuth;
    service: CoordinatorService;
}) {
    /**
     * Handles a request for the coordinator screen. The page and its files are public: they are a form to sign in.
     * What the page shows comes from the screen's own API, which only a coordinator's token opens; the shared bearer
     * secret does not.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @param {string|undefined} token - The bearer token, if there is one.
     * @returns {Promise<void>}
     */
    return async function handleScreen(req: IncomingMessage, res: ServerResponse, token: string | undefined) {
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');

        if (!screen) {
            throw new HttpError(404, 'not found');
        }

        const file = req.method === 'GET' ? SCREEN_FILES[pathname] : undefined;

        if (file) {
            res.writeHead(200, {
                'cache-control': 'no-store',
                'content-security-policy': 'default-src \'self\'; frame-ancestors \'none\'',
                'content-type': file.type
            });
            res.end(file.body);

            return;
        }
        if (!pathname.startsWith('/screen/api/')) {
            throw new HttpError(404, 'not found');
        }
        if (!token) {
            res.setHeader('www-authenticate', 'Bearer');
            throw new HttpError(401, 'sign in with a coordinator token');
        }

        let coordinator;

        try {
            coordinator = await verifyCoordinator(token, screen);
        } catch (error) {
            if (error instanceof SignInError) {
                send(res, 403, { error: error.code });

                return;
            }
            throw error;
        }

        try {
            const route = pathname.slice('/screen/api'.length);

            if (route === '/state' && req.method === 'GET') {
                const rooms = await service.rooms();
                const queues = service.queues(rooms);
                const examination = service.examinationQueues(rooms);
                const onScreen = (entries: { encounterId: string; }[]) => entries.map(e => screenEntry(service, e));
                const eachOnScreen = (lists: Record<string, { encounterId: string; }[]>) =>
                    Object.fromEntries(Object.entries(lists).map(([ key, entries ]) => [ key, onScreen(entries) ]));
                const recent = Date.now() - 2 * 60_000;

                send(res, 200, {
                    clinics: service.clinics(),
                    coordinator,
                    examination: {
                        doctors: eachOnScreen(examination.doctors),
                        unassigned: onScreen(examination.unassigned)
                    },
                    nhso: {
                        bypass: service.bypassToday() ?? null,
                        statuses: service.nhsoStatuses()
                    },
                    moves: service.state.moves
                        .filter(m => m.startedAt.getTime() >= recent || m.state === 'counting_down')
                        .map(m => ({
                            destination: m.destination,
                            endpointId: m.endpointId,
                            id: m.id,
                            origin: m.origin,
                            reason: m.reason,
                            startedAt: m.startedAt,
                            state: m.state
                        })),
                    questionnaires: {
                        catalogue: service.questionnaireCatalogue().map(({ id, title }) => ({ id, title })),
                        sent: Object.fromEntries(service.state.encounters
                            .filter(e => e.stage !== 'done' && e.questionnaires?.length)
                            .map(e => [ e.id, (e.questionnaires ?? []).map(describeSent) ]))
                    },
                    queues: eachOnScreen(queues),
                    rooms,
                    videoCatalogue: service.videoCatalogue().map(({ id, title }) => ({ id, title })),
                    videos: service.playingVideos(),
                    stages: service.stages().map(({ id, name }) => ({ id, name })),
                    teams: service.teams(rooms)
                });

                return;
            }
            if (!await act(req, res, route, coordinator.id)) {
                throw new HttpError(404, 'not found');
            }
        } catch (error) {
            if (error instanceof ProsodyUnavailableError) {
                throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
            }
            throw error;
        }
    };
}
