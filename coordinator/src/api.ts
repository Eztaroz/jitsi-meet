/**
 * The coordinator service's API. The hospital's system calls it with the shared bearer secret, on the internal
 * network only. Encounters are identified by an opaque id; an HN appears only in the request that starts one and in
 * what is read back.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import type { Flow } from './flow.ts';
import { errorCode, log } from './log.ts';
import { type IEncounter, type IMove, STAGES, type Stage } from './patientFlow.ts';
import { ProsodyUnavailableError } from './prosody.ts';
import { RecorderBotUnavailableError } from './recorderBot.ts';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_HN_LENGTH = 128;

class HttpError extends Error {
    readonly status: number;

    /**
     * An error answered with an HTTP status.
     *
     * @param {number} status - The HTTP status.
     * @param {string} message - The error message sent to the client.
     */
    constructor(status: number, message: string) {
        super(message);
        this.status = status;
    }
}

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
 * Sends a JSON response.
 *
 * @param {ServerResponse} res - The response.
 * @param {number} status - The HTTP status.
 * @param {unknown} body - The body.
 * @returns {void}
 */
function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Reads a JSON request body.
 *
 * @param {IncomingMessage} req - The request.
 * @returns {Promise<unknown>}
 */
async function readJson(req: IncomingMessage): Promise<unknown> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new HttpError(413, 'request body too large');
        }
        chunks.push(chunk);
    }

    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'request body must be JSON');
    }
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
 * Describes an encounter for the API; the HN is only in what is read, never in the id.
 *
 * @param {IEncounter} e - The encounter.
 * @returns {Object}
 */
function encounterBody(e: IEncounter) {
    return {
        history: e.history,
        hn: e.hn,
        id: e.id,
        stage: e.stage,
        stageStartedAt: e.stageStartedAt,
        startedAt: e.startedAt,
        unfinished: e.unfinished
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
 * Creates the API server.
 *
 * @param {Object} options - Options.
 * @param {Flow} options.flow - The patient-flow runner.
 * @param {string} options.secret - The shared bearer secret.
 * @returns {Server}
 */
export function createApi({ flow, secret }: { flow: Flow; secret: string; }): Server {
    /**
     * Handles one request.
     *
     * @param {IncomingMessage} req - The request.
     * @param {ServerResponse} res - The response.
     * @returns {Promise<void>}
     */
    async function handle(req: IncomingMessage, res: ServerResponse) {
        const [ scheme, token ] = (req.headers.authorization ?? '').split(' ');

        if (scheme !== 'Bearer' || !token || !sameSecret(token, secret)) {
            res.setHeader('www-authenticate', 'Bearer');
            throw new HttpError(401, 'missing or wrong bearer secret');
        }

        const { pathname } = new URL(req.url ?? '/', 'http://localhost');

        if (pathname === '/health' && req.method === 'GET') {
            send(res, 200, {
                openEncounters: flow.state.encounters.filter(e => e.stage !== 'done').length,
                status: 'ok'
            });

            return;
        }
        if (pathname === '/encounters' && req.method === 'POST') {
            const hn = hnFrom(await readJson(req));

            try {
                const { encounter } = await flow.startEncounter(hn);

                send(res, encounter?.created ? 201 : 200,
                    { id: encounter?.id, stage: encounter?.stage, startedAt: encounter?.startedAt });
            } catch (error) {
                if (error instanceof RecorderBotUnavailableError) {
                    log.warn('could not start an encounter', { error: error.code });
                    throw new HttpError(503, `the recorder bot cannot record the room now (${error.code})`);
                }
                throw error;
            }

            return;
        }
        if (pathname === '/rooms' && req.method === 'GET') {
            try {
                send(res, 200, { rooms: await flow.rooms() });
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not read the rooms', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return;
        }
        if (pathname === '/moves' && req.method === 'POST') {
            const request = moveFrom(await readJson(req));

            try {
                const move = await flow.requestMove(request);

                send(res, move.state === 'refused' ? 200 : 202, moveBody(move));
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not send a move', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return;
        }

        if (pathname === '/queues' && req.method === 'GET') {
            const queues = flow.queues();
            const hnOf = (id: string) => flow.state.encounters.find(e => e.id === id)?.hn;

            send(res, 200, { queues: Object.fromEntries(Object.entries(queues).map(([ stage, entries ]) =>
                [ stage, entries.map(e => ({ ...e, hn: hnOf(e.encounterId) })) ])) });

            return;
        }

        const encounterMatch = /^\/encounters\/([^/]+)$/.exec(pathname);

        if (encounterMatch && req.method === 'GET') {
            const encounter = flow.state.encounters.find(e => e.id === decodeURIComponent(encounterMatch[1]));

            if (!encounter) {
                throw new HttpError(404, 'no such encounter');
            }
            send(res, 200, encounterBody(encounter));

            return;
        }

        const stageMatch = /^\/encounters\/([^/]+)\/stage$/.exec(pathname);

        if (stageMatch && req.method === 'POST') {
            const stage = (await readJson(req) as { stage?: unknown; } | null)?.stage;

            if (typeof stage !== 'string' || !(STAGES as readonly string[]).includes(stage)) {
                throw new HttpError(400, `stage must be one of ${STAGES.join(', ')}`);
            }

            const { encounter, refused } = await flow.changeStage(decodeURIComponent(stageMatch[1]), stage as Stage);

            if (refused === 'unknown_encounter') {
                throw new HttpError(404, 'no such encounter');
            }
            if (refused === 'encounter_closed') {
                throw new HttpError(409, 'the encounter is done');
            }
            send(res, 200, encounterBody(flow.state.encounters.find(e => e.id === encounter?.id) as IEncounter));

            return;
        }

        const moveMatch = /^\/moves\/([^/]+)$/.exec(pathname);

        if (moveMatch && req.method === 'GET') {
            const move = flow.state.moves.find(m => m.id === decodeURIComponent(moveMatch[1]));

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
