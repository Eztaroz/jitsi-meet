import { readFileSync } from 'node:fs';

import { type IRoleMarkers, parseRoleMarker } from './rooms.ts';

/**
 * The coordinator service's settings, read from environment variables. `coordinator/deploy/README.md` documents each.
 */

export interface IConfig {

    /** The port the API listens on. */
    apiPort: number;

    /** The shared bearer secret the hospital's system must send. */
    apiSecret: string;

    /** The directory holding the database; mount a volume here. */
    dataDir: string;

    /** Prosody's HTTP base URL, where the coordinator API module listens. Internal network only. */
    prosodyUrl: string;

    /** The recorder bot service's bearer secret. */
    recorderBotSecret: string;

    /** The recorder bot service's base URL. */
    recorderBotUrl: string;

    /** Which verified identities are patients and which staff. */
    roleMarkers: IRoleMarkers;

    /** The service's key id and its PEM private key; Prosody has the public key (ADR 0009). */
    signingKey: { kid: string; privateKey: string; };
}

/**
 * Reads a required setting.
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
 * Loads the settings.
 *
 * @param {NodeJS.ProcessEnv} env - The environment.
 * @returns {IConfig}
 */
export function loadConfig(env: NodeJS.ProcessEnv = process.env): IConfig {
    return {
        apiPort: Number(env.COORDINATOR_API_PORT ?? 8091),
        apiSecret: required(env, 'COORDINATOR_API_SECRET'),
        dataDir: env.COORDINATOR_DATA_DIR?.trim() || '/var/lib/coordinator',
        prosodyUrl: required(env, 'COORDINATOR_PROSODY_URL').replace(/\/+$/u, ''),
        recorderBotSecret: required(env, 'COORDINATOR_RECORDER_BOT_SECRET'),
        recorderBotUrl: required(env, 'COORDINATOR_RECORDER_BOT_URL').replace(/\/+$/u, ''),
        roleMarkers: {
            patient: parseRoleMarker(env.COORDINATOR_PATIENT_MARKER, 'COORDINATOR_PATIENT_MARKER'),
            staff: parseRoleMarker(env.COORDINATOR_STAFF_MARKER, 'COORDINATOR_STAFF_MARKER')
        },
        signingKey: {
            kid: required(env, 'COORDINATOR_SIGNING_KID'),
            privateKey: readFileSync(required(env, 'COORDINATOR_SIGNING_KEY_FILE'), 'utf8')
        }
    };
}
