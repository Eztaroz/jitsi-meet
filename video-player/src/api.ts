/**
 * The control API. The coordinator service calls it to play a video into a room and to stop it. It is meant for the
 * hospital's internal network only, and every request must carry the shared bearer secret.
 *
 *   GET  /health  -> 200 { status, activeRooms, maxRooms, rooms }
 *   POST /play    { room, token, videoUrl } -> 201 { room, status: 'playing' }; 409 if the room has a video, 503 above
 *                 capacity, 502 if the browser cannot start
 *   POST /stop    { room } -> 200 { room, status: 'stopped' }; 404 if nothing plays in the room
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import { errorCode, log } from './log.ts';
import { AlreadyPlayingError, AtCapacityError, type Players } from './players.ts';

const MAX_BODY_BYTES = 16 * 1024;
const MAX_ROOM_LENGTH = 256;

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
 * @returns {Promise<Record<string, unknown>>}
 */
async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = [];
    let size = 0;

    for await (const chunk of req) {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
            throw new HttpError(413, 'request body too large');
        }
        chunks.push(chunk);
    }

    let body: unknown;

    try {
        body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw new HttpError(400, 'request body must be JSON');
    }
    if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new HttpError(400, 'request body must be a JSON object');
    }

    return body as Record<string, unknown>;
}

/**
 * Reads a required, non-empty string of a request body.
 *
 * @param {Record<string, unknown>} body - The body.
 * @param {string} name - The field.
 * @returns {string}
 */
function stringField(body: Record<string, unknown>, name: string): string {
    const value = body[name];

    if (typeof value !== 'string' || !value.trim()) {
        throw new HttpError(400, `${name} must be a non-empty string`);
    }

    return value;
}

/**
 * Reads the room of a request body.
 *
 * @param {Record<string, unknown>} body - The body.
 * @returns {string}
 */
function roomFrom(body: Record<string, unknown>): string {
    const room = stringField(body, 'room');

    if (room.length > MAX_ROOM_LENGTH) {
        throw new HttpError(400, `room must be at most ${MAX_ROOM_LENGTH} characters`);
    }

    return room;
}

/**
 * Reads the video of a request body: an http(s) URL.
 *
 * @param {Record<string, unknown>} body - The body.
 * @returns {string}
 */
function videoUrlFrom(body: Record<string, unknown>): string {
    const videoUrl = stringField(body, 'videoUrl');
    let protocol: string;

    try {
        ({ protocol } = new URL(videoUrl));
    } catch {
        throw new HttpError(400, 'videoUrl must be a URL');
    }
    if (protocol !== 'http:' && protocol !== 'https:') {
        throw new HttpError(400, 'videoUrl must be an http or https URL');
    }

    return videoUrl;
}

/**
 * Creates the control API server.
 *
 * @param {Object} options - Options.
 * @param {number} options.maxRooms - The capacity, for health.
 * @param {Players} options.players - The rooms being played in.
 * @param {string} options.secret - The shared bearer secret.
 * @returns {Server}
 */
export function createApi({ maxRooms, players, secret }: { maxRooms: number; players: Players; secret: string; }): Server {
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
            const rooms = players.active();

            send(res, 200, { activeRooms: rooms.length, maxRooms, rooms, status: 'ok' });

            return;
        }

        if (pathname === '/play' && req.method === 'POST') {
            const body = await readJson(req);
            const room = roomFrom(body);
            const params = { room, token: stringField(body, 'token'), videoUrl: videoUrlFrom(body) };

            try {
                await players.play(params);
            } catch (error) {
                if (error instanceof AlreadyPlayingError) {
                    throw new HttpError(409, 'a video is already playing in that room');
                }
                if (error instanceof AtCapacityError) {
                    throw new HttpError(503, 'the video player service is playing in as many rooms as it may');
                }
                log.error('video player could not start', { error: errorCode(error) });
                throw new HttpError(502, 'the video player could not start');
            }
            send(res, 201, { room, status: 'playing' });

            return;
        }

        if (pathname === '/stop' && req.method === 'POST') {
            const room = roomFrom(await readJson(req));

            if (!await players.stop(room)) {
                throw new HttpError(404, 'no video is playing in that room');
            }
            send(res, 200, { room, status: 'stopped' });

            return;
        }

        throw new HttpError(404, 'not found');
    }

    return createServer((req, res) => {
        handle(req, res).catch(error => {
            if (error instanceof HttpError) {
                send(res, error.status, { error: error.message });
            } else {
                log.error('control API request failed', { error: errorCode(error) });
                send(res, 500, { error: 'internal error' });
            }
        });
    });
}
