/**
 * The coordinator service's API. The hospital's system calls it with the shared bearer secret, on the internal
 * network only. Encounters are identified by an opaque id; an HN appears only in the request that starts one and in
 * what is read back.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { errorCode, log } from './log.ts';
import { type IState, step } from './patientFlow.ts';
import { Prosody, ProsodyUnavailableError } from './prosody.ts';
import { RecorderBot, RecorderBotUnavailableError } from './recorderBot.ts';
import { type IRoleMarkers, describeRooms } from './rooms.ts';
import type { Store } from './store.ts';

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
 * Creates the API server.
 *
 * @param {Object} options - Options.
 * @param {Prosody} options.prosody - The Prosody client.
 * @param {RecorderBot} options.recorderBot - The recorder bot client.
 * @param {IRoleMarkers} options.roleMarkers - Which identities are patients and which staff.
 * @param {string} options.secret - The shared bearer secret.
 * @param {Store} options.store - The storage.
 * @returns {Server}
 */
export function createApi({ prosody, recorderBot, roleMarkers, secret, store }: {
    prosody: Prosody;
    recorderBot: RecorderBot;
    roleMarkers: IRoleMarkers;
    secret: string;
    store: Store;
}): Server {
    let state: IState = store.load();

    // Requests are handled one at a time, so a repeated start cannot open two encounters.
    let queue: Promise<unknown> = Promise.resolve();

    /**
     * Starts an encounter, or returns the open one.
     *
     * @param {string} hn - The patient's HN.
     * @returns {Promise<{ created: boolean; encounter: object; }>}
     */
    function startEncounter(hn: string) {
        const run = async () => {
            const { commands, result, state: next } = step(state, { at: new Date(), hn, type: 'start_encounter' });

            // Nothing is saved unless the recorder bot accepted the room, so no encounter goes unrecorded.
            for (const command of commands) {
                await recorderBot.recordRoom(command.hn);
            }
            if (next !== state) {
                store.save(next);
                state = next;
            }

            const { created, ...encounter } = result!;

            return { created, encounter: { id: encounter.id, stage: encounter.stage, startedAt: encounter.startedAt } };
        };
        const answer = queue.then(run, run);

        queue = answer.catch(() => undefined);

        return answer;
    }

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
            send(res, 200, { openEncounters: state.encounters.filter(e => e.stage !== 'done').length, status: 'ok' });

            return;
        }
        if (pathname === '/encounters' && req.method === 'POST') {
            const hn = hnFrom(await readJson(req));

            try {
                const { created, encounter } = await startEncounter(hn);

                send(res, created ? 201 : 200, encounter);
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
                send(res, 200, { rooms: describeRooms(await prosody.rooms(), roleMarkers) });
            } catch (error) {
                if (error instanceof ProsodyUnavailableError) {
                    log.warn('could not read the rooms', { error: error.code });
                    throw new HttpError(503, `Prosody cannot be asked now (${error.code})`);
                }
                throw error;
            }

            return;
        }

        const match = /^\/encounters\/([^/]+)$/.exec(pathname);

        if (match && req.method === 'GET') {
            const encounter = state.encounters.find(e => e.id === decodeURIComponent(match[1]));

            if (!encounter) {
                throw new HttpError(404, 'no such encounter');
            }
            send(res, 200, { hn: encounter.hn, id: encounter.id, stage: encounter.stage, startedAt: encounter.startedAt });

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
