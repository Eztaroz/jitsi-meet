/**
 * The coordinator's screen: the page and its files, and the API behind it, which a coordinator's token opens.
 */
import { readFileSync } from 'node:fs';
import type { IncomingMessage, ServerResponse } from 'node:http';

import type { CoordinatorService } from './coordinatorService.ts';
import { HttpError, send } from './http.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { type ICoordinatorAuth, SignInError, verifyCoordinator } from './screenAuth.ts';

/** The files of the coordinator screen, read once. */
const SCREEN_FILES: Record<string, { body: Buffer; type: string; }> = {};

for (const [ route, file, type ] of [
    [ '/screen', 'index.html', 'text/html; charset=utf-8' ],
    [ '/screen/screen.css', 'screen.css', 'text/css; charset=utf-8' ],
    [ '/screen/screen.js', 'screen.js', 'text/javascript; charset=utf-8' ]
]) {
    SCREEN_FILES[route] = { body: readFileSync(new URL(`./screen/${file}`, import.meta.url)), type };
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
                const queues = service.queues();
                const hnOf = (id: string) => service.state.encounters.find(e => e.id === id)?.hn;
                const recent = Date.now() - 2 * 60_000;

                send(res, 200, {
                    coordinator,
                    moves: service.state.moves
                        .filter(m => m.startedAt.getTime() >= recent || m.state === 'counting_down' || m.state === 'preparing')
                        .map(m => ({
                            destination: m.destination,
                            endpointId: m.endpointId,
                            id: m.id,
                            origin: m.origin,
                            reason: m.reason,
                            startedAt: m.startedAt,
                            state: m.state
                        })),
                    queues: Object.fromEntries(Object.entries(queues).map(([ stage, entries ]) =>
                        [ stage, entries.map(e => ({ ...e, hn: hnOf(e.encounterId) })) ])),
                    rooms: await service.rooms()
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
