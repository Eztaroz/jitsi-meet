import { type IRoleMarkers, parseRoleMarker } from './identity.ts';

/**
 * The recorder bot service's settings, read from environment variables so that administrators can tune the service
 * without code changes. `recorder-bot/deploy/README.md` documents each one.
 */

export interface IConfig {

    /** The port the control API listens on. */
    apiPort: number;

    /** The shared bearer secret every control API request must carry. */
    apiSecret: string;

    /** The bot account, on the hidden recorder domain. */
    botJid: string;

    /** The bot account's password. */
    botPassword: string;

    /** The Chromium binary to run; Playwright's own when unset. */
    chromiumPath?: string;

    /** How long the bot stays in a room every human has left, in milliseconds (ADR 0003). */
    emptyRoomGraceMs: number;

    /** How long the bot waits for the first human to join, in milliseconds (ADR 0003). */
    firstJoinWaitMs: number;

    /** Whether to accept the Jitsi web server's certificate without checking it. For local test deployments. */
    ignoreCertificateErrors: boolean;

    /** The base URL of the Jitsi web server. The bot page is served from it. */
    jitsiUrl: string;

    /** How many consultations the service records at once. It refuses more. */
    maxConsultations: number;

    /** The highest video resolution the bot asks for. */
    maxHeight: number;

    /**
     * How many times a consultation's bot may be relaunched after it crashed or lost its connection. Once they are
     * used up, the consultation stops and stores what was recorded.
     */
    maxRelaunches: number;

    /** How long evidence recordings are kept, in milliseconds (ADR 0003). Older ones are deleted. */
    retentionMs: number;

    /** How often the service deletes the evidence recordings older than the retention period, in milliseconds. */
    retentionSweepMs: number;

    /**
     * Which verified identities are staff and which the patient. With none, the service records no identities, so no
     * staff visits.
     */
    roleMarkers: IRoleMarkers;

    /**
     * Where consultations are recorded while they run and finalised, before they move to the storage root. It must
     * be on persistent local storage.
     */
    spoolDir: string;

    /** The evidence storage root: where finalised evidence recordings are kept. */
    storageRoot: string;

    /**
     * How often the service retries moving the evidence recordings left in the spool into the storage root, in
     * milliseconds.
     */
    storeRetryMs: number;
}

export const DAY_MS = 24 * 60 * 60 * 1000;

/** The longest interval a timer takes, in seconds: a day. */
const MAX_INTERVAL_SECONDS = 24 * 60 * 60;

/**
 * Reads a required variable.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} name - The variable.
 * @returns {string}
 */
function required(env: NodeJS.ProcessEnv, name: string): string {
    const value = env[name]?.trim();

    if (!value) {
        throw new Error(`${name} must be set`);
    }

    return value;
}

/**
 * Reads an integer variable.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} name - The variable.
 * @param {number} fallback - The default.
 * @param {number} min - The lowest value allowed.
 * @param {number} max - The highest value allowed.
 * @returns {number}
 */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, min = 1, max = Number.MAX_SAFE_INTEGER): number {
    const raw = env[name]?.trim();

    if (!raw) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < min || value > max) {
        throw new Error(`${name} must be an integer from ${min} to ${max}, got "${raw}"`);
    }

    return value;
}

/**
 * Reads a boolean variable.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} name - The variable.
 * @returns {boolean}
 */
function flag(env: NodeJS.ProcessEnv, name: string): boolean {
    return [ '1', 'true', 'yes' ].includes(env[name]?.trim().toLowerCase() ?? '');
}

/**
 * Reads the configuration from the environment.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @returns {IConfig}
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IConfig {
    return {
        apiPort: integer(env, 'RECORDER_BOT_API_PORT', 8090),
        apiSecret: required(env, 'RECORDER_BOT_API_SECRET'),
        botJid: required(env, 'RECORDER_BOT_JID'),
        botPassword: required(env, 'RECORDER_BOT_PASSWORD'),
        chromiumPath: env.RECORDER_BOT_CHROMIUM_PATH?.trim() || undefined,
        emptyRoomGraceMs: integer(env, 'RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS', 60) * 1000,
        firstJoinWaitMs: integer(env, 'RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS', 600) * 1000,
        ignoreCertificateErrors: flag(env, 'RECORDER_BOT_IGNORE_CERTIFICATE_ERRORS'),
        jitsiUrl: required(env, 'RECORDER_BOT_JITSI_URL').replace(/\/+$/, ''),
        maxConsultations: integer(env, 'RECORDER_BOT_MAX_CONSULTATIONS', 2),
        maxHeight: integer(env, 'RECORDER_BOT_MAX_HEIGHT', 720),
        maxRelaunches: integer(env, 'RECORDER_BOT_MAX_RELAUNCHES', 3, 0),
        retentionMs: integer(env, 'RECORDER_BOT_RETENTION_DAYS', 90) * DAY_MS,
        retentionSweepMs: integer(env, 'RECORDER_BOT_RETENTION_SWEEP_SECONDS', 3600, 1, MAX_INTERVAL_SECONDS) * 1000,
        roleMarkers: {
            patient: parseRoleMarker(env.RECORDER_BOT_PATIENT_MARKER, 'RECORDER_BOT_PATIENT_MARKER'),
            staff: parseRoleMarker(env.RECORDER_BOT_STAFF_MARKER, 'RECORDER_BOT_STAFF_MARKER')
        },
        spoolDir: required(env, 'RECORDER_BOT_SPOOL_DIR'),
        storageRoot: required(env, 'RECORDER_BOT_STORAGE_ROOT'),
        storeRetryMs: integer(env, 'RECORDER_BOT_STORE_RETRY_SECONDS', 60, 1, MAX_INTERVAL_SECONDS) * 1000
    };
}
