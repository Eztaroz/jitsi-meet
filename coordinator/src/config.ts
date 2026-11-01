import { readFileSync } from 'node:fs';

import { type ILayout, type IRoleMarkers, parseRoleMarker } from './rooms.ts';

/**
 * The coordinator service's settings, read from environment variables. `coordinator/deploy/README.md` documents each.
 */

export interface IConfig {

    /** The port the API listens on. */
    apiPort: number;

    /** The shared bearer secret the hospital's system must send. */
    apiSecret: string;

    /** The key of the references to patients' rooms in the audit log (`COORDINATOR_AUDIT_KEY`; the API secret by default). */
    auditKey: string;

    /** The directory holding the database; mount a volume here. */
    dataDir: string;

    /** The stations and lounges (`COORDINATOR_ROOMS_FILE`). */
    layout: ILayout;

    /** Prosody's HTTP base URL, where the coordinator API module listens. Internal network only. */
    prosodyUrl: string;

    /** The recorder bot service's bearer secret. */
    recorderBotSecret: string;

    /** The recorder bot service's base URL. */
    recorderBotUrl: string;

    /** How long encounters and audit entries are kept, in milliseconds. Older ones are deleted. */
    retentionMs: number;

    /** How often the retention sweep runs, in milliseconds. */
    retentionSweepMs: number;

    /** Which verified identities are patients and which staff. */
    roleMarkers: IRoleMarkers;

    /** The service's key id and its PEM private key; Prosody has the public key (ADR 0009). */
    signingKey: { kid: string; privateKey: string; };

    /** The IANA time zone whose midnight closes the day's encounters. */
    timeZone: string;

    /** What the destination tokens claim, as Prosody is set to accept them (ADR 0009). */
    token: { audience: string; issuer: string; subject: string; };
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
        auditKey: env.COORDINATOR_AUDIT_KEY?.trim() || required(env, 'COORDINATOR_API_SECRET'),
        retentionMs: Number(env.COORDINATOR_RETENTION_DAYS ?? 90) * 24 * 60 * 60 * 1000,
        retentionSweepMs: Number(env.COORDINATOR_RETENTION_SWEEP_SECONDS ?? 3600) * 1000,
        timeZone: loadTimeZone(env.COORDINATOR_TIME_ZONE?.trim()),
        layout: loadLayout(env.COORDINATOR_ROOMS_FILE?.trim()),
        prosodyUrl: required(env, 'COORDINATOR_PROSODY_URL').replace(/\/+$/u, ''),
        recorderBotSecret: required(env, 'COORDINATOR_RECORDER_BOT_SECRET'),
        recorderBotUrl: required(env, 'COORDINATOR_RECORDER_BOT_URL').replace(/\/+$/u, ''),
        roleMarkers: {
            patient: parseRoleMarker(env.COORDINATOR_PATIENT_MARKER, 'COORDINATOR_PATIENT_MARKER'),
            staff: parseRoleMarker(env.COORDINATOR_STAFF_MARKER, 'COORDINATOR_STAFF_MARKER')
        },
        token: {
            audience: env.COORDINATOR_TOKEN_AUDIENCE?.trim() || 'jitsi',
            issuer: env.COORDINATOR_TOKEN_ISSUER?.trim() || 'coordinator',
            subject: required(env, 'COORDINATOR_TOKEN_SUBJECT')
        },
        signingKey: {
            kid: required(env, 'COORDINATOR_SIGNING_KID'),
            privateKey: readFileSync(required(env, 'COORDINATOR_SIGNING_KEY_FILE'), 'utf8')
        }
    };
}

/**
 * Reads the stations and lounges from a JSON file: `{ "stations": [ { "room", "stage" } ], "lounges": [ { "room" } ] }`.
 *
 * @param {string|undefined} file - The file; unset for none.
 * @returns {ILayout}
 * @throws {Error} When the file is malformed.
 */
export function loadLayout(file: string | undefined): ILayout {
    if (!file) {
        return { lounges: [], stations: [] };
    }

    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<Record<keyof ILayout, { room?: unknown; stage?: unknown; }[]>>;
    const named = (entries: { room?: unknown; stage?: unknown; }[] | undefined, what: string) => (entries ?? []).map(e => {
        if (typeof e.room !== 'string' || !e.room.trim()) {
            throw new Error(`COORDINATOR_ROOMS_FILE: every ${what} needs a "room"`);
        }

        return e as { room: string; stage?: unknown; };
    });

    return {
        lounges: named(raw.lounges, 'lounge').map(l => ({ room: l.room })),
        stations: named(raw.stations, 'station').map(s => {
            if (s.stage !== 'intake' && s.stage !== 'aftercare') {
                throw new Error('COORDINATOR_ROOMS_FILE: every station needs a "stage", intake or aftercare');
            }

            return { room: s.room, stage: s.stage };
        })
    };
}

/**
 * Checks a time zone.
 *
 * @param {string|undefined} zone - An IANA time zone; unset for UTC.
 * @returns {string}
 * @throws {Error} When it is not a time zone.
 */
export function loadTimeZone(zone: string | undefined): string {
    const timeZone = zone || 'UTC';

    try {
        new Intl.DateTimeFormat('en-US', { timeZone });
    } catch {
        throw new Error(`COORDINATOR_TIME_ZONE must be an IANA time zone, got "${timeZone}"`);
    }

    return timeZone;
}
