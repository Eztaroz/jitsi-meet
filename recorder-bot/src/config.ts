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

    /** The highest video resolution the bot asks for. */
    maxHeight: number;

    /**
     * Where consultations are recorded while they run and finalised, before they move to the storage root. It must
     * be on persistent local storage.
     */
    spoolDir: string;

    /** The evidence storage root: where finalised evidence recordings are kept. */
    storageRoot: string;
}

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
 * Reads a positive integer variable.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} name - The variable.
 * @param {number} fallback - The default.
 * @returns {number}
 */
function positiveInteger(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = env[name]?.trim();

    if (!raw) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
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
        apiPort: positiveInteger(env, 'RECORDER_BOT_API_PORT', 8090),
        apiSecret: required(env, 'RECORDER_BOT_API_SECRET'),
        botJid: required(env, 'RECORDER_BOT_JID'),
        botPassword: required(env, 'RECORDER_BOT_PASSWORD'),
        chromiumPath: env.RECORDER_BOT_CHROMIUM_PATH?.trim() || undefined,
        emptyRoomGraceMs: positiveInteger(env, 'RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS', 60) * 1000,
        firstJoinWaitMs: positiveInteger(env, 'RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS', 600) * 1000,
        ignoreCertificateErrors: flag(env, 'RECORDER_BOT_IGNORE_CERTIFICATE_ERRORS'),
        jitsiUrl: required(env, 'RECORDER_BOT_JITSI_URL').replace(/\/+$/, ''),
        maxHeight: positiveInteger(env, 'RECORDER_BOT_MAX_HEIGHT', 720),
        spoolDir: required(env, 'RECORDER_BOT_SPOOL_DIR'),
        storageRoot: required(env, 'RECORDER_BOT_STORAGE_ROOT')
    };
}
