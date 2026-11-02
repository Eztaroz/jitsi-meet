/**
 * What the coordinator service's HTTP routes share: errors answered with a status, JSON in and out.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

const MAX_BODY_BYTES = 16 * 1024;

export class HttpError extends Error {
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
 * Sends a JSON response.
 *
 * @param {ServerResponse} res - The response.
 * @param {number} status - The HTTP status.
 * @param {unknown} body - The body.
 * @returns {void}
 */
export function send(res: ServerResponse, status: number, body: unknown) {
    res.writeHead(status, { 'cache-control': 'no-store', 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
}

/**
 * Reads a JSON request body.
 *
 * @param {IncomingMessage} req - The request.
 * @returns {Promise<unknown>}
 */
export async function readJson(req: IncomingMessage): Promise<unknown> {
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
