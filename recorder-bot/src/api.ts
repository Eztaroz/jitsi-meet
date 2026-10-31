/**
 * The control API. The hospital's room-creation system calls it to record a patient's room and to follow the
 * consultation. It is meant for the hospital's internal network only, and every request must carry the shared bearer
 * secret.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';

import type { Consultations } from './consultations.ts';
import { log } from './log.ts';
import { roomNameFromHn } from './roomName.ts';

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
    if (/[\u0000-\u001f\u007f]/.test(hn) || [ '.', '..' ].includes(roomNameFromHn(hn))) {
        throw new HttpError(400, 'hn is not a usable room name');
    }

    return hn;
}

/**
 * Creates the control API server.
 *
 * @param {Object} options - Options.
 * @param {Consultations} options.consultations - The consultations.
 * @param {string} options.secret - The shared bearer secret.
 * @returns {Server}
 */
export function createApi({ consultations, secret }: { consultations: Consultations; secret: string; }): Server {
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
            send(res, 200, { activeConsultations: consultations.active().length, status: 'ok' });

            return;
        }
        if (pathname === '/consultations' && req.method === 'POST') {
            const consultation = consultations.start(hnFrom(await readJson(req)));
            const { consultationId, status } = consultation.snapshot();

            send(res, 201, { consultationId, status });

            return;
        }

        const match = /^\/consultations\/([^/]+)$/.exec(pathname);

        if (match && req.method === 'GET') {
            const consultation = consultations.get(decodeURIComponent(match[1]));

            if (!consultation) {
                throw new HttpError(404, 'no such consultation');
            }
            send(res, 200, consultation.snapshot());

            return;
        }

        throw new HttpError(404, 'not found');
    }

    return createServer((req, res) => {
        handle(req, res).catch(error => {
            if (error instanceof HttpError) {
                send(res, error.status, { error: error.message });
            } else {
                log.error('control API request failed', { error: error instanceof Error ? error.name : 'unknown' });
                send(res, 500, { error: 'internal error' });
            }
        });
    });
}
