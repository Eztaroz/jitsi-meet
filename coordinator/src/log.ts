/**
 * The service's logger. It writes one JSON object per line to stdout.
 *
 * Logs identify encounters by their opaque id. Never pass an HN or a room name: the room name is the
 * patient's HN (ADR 0005).
 */

type Level = 'debug' | 'info' | 'warn' | 'error';

export interface ILogFields {
    [key: string]: string | number | boolean | undefined;
    encounterId?: string;
}

/**
 * Writes one log line.
 *
 * @param {Level} level - The level.
 * @param {string} message - What happened.
 * @param {ILogFields} fields - Context. Never an HN or a room name.
 * @returns {void}
 */
function write(level: Level, message: string, fields: ILogFields = {}) {
    process.stdout.write(`${JSON.stringify({ time: new Date().toISOString(), level, message, ...fields })}\n`);
}

export const log = {
    debug: (message: string, fields?: ILogFields) => write('debug', message, fields),
    error: (message: string, fields?: ILogFields) => write('error', message, fields),
    info: (message: string, fields?: ILogFields) => write('info', message, fields),
    warn: (message: string, fields?: ILogFields) => write('warn', message, fields)
};

/**
 * Describes an error for the logs by its code or name only. Messages of filesystem errors name paths, and evidence
 * paths hold the room name, which is the patient's HN.
 *
 * @param {unknown} error - The error.
 * @returns {string}
 */
export function errorCode(error: unknown): string {
    const code = (error as { code?: unknown; } | undefined)?.code;

    if (typeof code === 'string' || typeof code === 'number') {
        return String(code);
    }

    return error instanceof Error ? error.name : 'unknown';
}
