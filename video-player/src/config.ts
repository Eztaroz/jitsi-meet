/**
 * The video player service's settings, read from environment variables so that administrators can tune the service
 * without code changes. `video-player/deploy/README.md` documents each one.
 */

export interface IConfig {

    /** The port the control API listens on. */
    apiPort: number;

    /** The shared bearer secret every control API request must carry. */
    apiSecret: string;

    /** The Chromium binary to run; Playwright's own when unset. */
    chromiumPath?: string;

    /** Whether to accept the Jitsi web server's certificate without checking it. For local test deployments. */
    ignoreCertificateErrors: boolean;

    /** The base URL of the Jitsi web server. The player page is served from it. */
    jitsiUrl: string;

    /** How many rooms the service plays in at once. It refuses more. */
    maxRooms: number;
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
 * Reads an integer variable.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @param {string} name - The variable.
 * @param {number} fallback - The default.
 * @returns {number}
 */
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
    const raw = env[name]?.trim();

    if (!raw) {
        return fallback;
    }

    const value = Number(raw);

    if (!Number.isInteger(value) || value < 1) {
        throw new Error(`${name} must be a positive integer, got "${raw}"`);
    }

    return value;
}

/**
 * Reads the configuration from the environment.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @returns {IConfig}
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IConfig {
    return {
        apiPort: integer(env, 'VIDEO_PLAYER_API_PORT', 8091),
        apiSecret: required(env, 'VIDEO_PLAYER_API_SECRET'),
        chromiumPath: env.VIDEO_PLAYER_CHROMIUM_PATH?.trim() || undefined,
        ignoreCertificateErrors: [ '1', 'true', 'yes' ].includes(env.VIDEO_PLAYER_IGNORE_CERTIFICATE_ERRORS?.trim().toLowerCase() ?? ''),
        jitsiUrl: required(env, 'VIDEO_PLAYER_JITSI_URL').replace(/\/+$/, ''),
        maxRooms: integer(env, 'VIDEO_PLAYER_MAX_ROOMS', 2)
    };
}
