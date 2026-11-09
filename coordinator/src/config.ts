import { readFileSync } from 'node:fs';

import {
    type ILayout,
    type IRoleMarker,
    type IRoleMarkers,
    type IStation,
    type StationStage,
    parseRoleMarker,
    sameRoom
} from './rooms.ts';

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

    /** The center, its stations and each station's lounge (`COORDINATOR_ROOMS_FILE`). */
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

    /**
     * How coordinators sign in to the screen. Unset, there is no screen. `keys` is where the hospital issuer's public
     * keys are: a directory, or the URL of a key server, as `<source>/<SHA-256 of the key id>.pem`.
     */
    screen?: {
        acceptedAudiences: string[];
        acceptedIssuers: string[];
        keys: string;
        marker: IRoleMarker;
    };

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
        screen: env.COORDINATOR_ISSUER_KEYS?.trim()
            ? {
                acceptedAudiences: (env.COORDINATOR_ACCEPTED_AUDIENCES ?? 'jitsi').split(',').map(a => a.trim()).filter(Boolean),
                acceptedIssuers: (env.COORDINATOR_ACCEPTED_ISSUERS ?? 'chat').split(',').map(a => a.trim()).filter(Boolean),
                keys: env.COORDINATOR_ISSUER_KEYS.trim(),
                marker: parseRoleMarker(env.COORDINATOR_COORDINATOR_MARKER ?? 'user.hospital_role=coordinator',
                    'COORDINATOR_COORDINATOR_MARKER') as IRoleMarker
            }
            : undefined,
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
 * Reads the centers, their stations and each station's lounge from a JSON file (ADR 0011):
 * `{ "centers": [ { "id", "stations": [ { "id", "stage", "lounge" } ] } ] }`. There is one center for now.
 *
 * @param {string|undefined} file - The file; unset for none.
 * @returns {ILayout}
 * @throws {Error} When the file is malformed, or in the format of station rooms.
 */
export function loadLayout(file: string | undefined): ILayout {
    if (!file) {
        return { centers: [] };
    }

    const raw = JSON.parse(readFileSync(file, 'utf8')) as { centers?: unknown; lounges?: unknown; stations?: unknown; };
    const fail = (why: string) => new Error(`COORDINATOR_ROOMS_FILE: ${why}`);

    if (raw.stations !== undefined || raw.lounges !== undefined) {
        throw fail('top-level "stations" and "lounges" are station rooms, which are gone: patients stay in their own '
            + 'room and a station is a team with its own lounge (ADR 0011). Write { "centers": [ { "id", "stations": '
            + '[ { "id", "stage", "lounge" } ] } ] }');
    }

    if (!Array.isArray(raw.centers) || raw.centers.length !== 1) {
        throw fail('needs "centers" with exactly one center');
    }

    const text = (value: unknown) => typeof value === 'string' && value.trim() !== '';
    const lounges: string[] = [];
    const ids: string[] = [];

    const centers = (raw.centers as { id?: unknown; stations?: unknown; }[]).map(center => {
        if (!text(center.id)) {
            throw fail('every center needs an "id"');
        }
        if (!Array.isArray(center.stations)) {
            throw fail(`center "${center.id}" needs "stations"`);
        }

        const stations = (center.stations as { id?: unknown; lounge?: unknown; stage?: unknown; }[]).map(s => {
            if (!text(s.id) || !text(s.lounge)) {
                throw fail('every station needs an "id" and a "lounge"');
            }
            if (s.stage !== 'intake' && s.stage !== 'examination' && s.stage !== 'aftercare') {
                throw fail(`station "${s.id}" needs a "stage": intake, examination or aftercare`);
            }

            const station: IStation = { id: s.id as string, lounge: s.lounge as string, stage: s.stage as StationStage };

            if (ids.includes(station.id)) {
                throw fail(`two stations are "${station.id}"`);
            }
            if (lounges.some(l => sameRoom(l, station.lounge))) {
                throw fail(`two stations have the lounge "${station.lounge}"`);
            }
            ids.push(station.id);
            lounges.push(station.lounge);

            return station;
        });

        return { id: center.id as string, stations };
    });

    return { centers };
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
