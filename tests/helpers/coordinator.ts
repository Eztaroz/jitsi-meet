import { execFileSync } from 'node:child_process';

import { config } from './TestsConfig';
import { expectations } from './expectations';
import { identityUnavailableReason } from './recorderBot';

/**
 * Helpers for the specs/coordinator tests, which drive the coordinator service (coordinator/) through its API and
 * observe the conferences from ordinary participants. The deployment is the recorder bot's JWT variant, so every
 * participant needs a token.
 */

/** An encounter as the API reports it. */
export interface IEncounter {
    history?: Array<{ at: string; stage: string; }>;
    hn?: string;
    id: string;
    stage: string;
    startedAt: string;
}

/**
 * Returns why the coordinator tests cannot run here, or undefined when they can.
 *
 * @returns {string|undefined}
 */
export function coordinatorUnavailableReason(): string | undefined {
    if (!expectations.recorderBot.verifiedIdentities) {
        return 'the coordinator needs the JWT variant of the test deployment';
    }
    if (!config.coordinator.apiUrl || !config.coordinator.apiSecret) {
        return 'COORDINATOR_API_URL and COORDINATOR_API_SECRET are not set';
    }

    // The tests build tokens and look at the recorder bot's hidden participant.
    return identityUnavailableReason();
}

/**
 * Calls the coordinator API.
 *
 * @param {string} route - The path, starting with "/".
 * @param {RequestInit} init - Request options.
 * @param {string|undefined} secret - The bearer secret; the right one by default. Pass '' to send none.
 * @returns {Promise<Response>}
 */
export function callCoordinator(route: string, init: RequestInit = {}, secret = config.coordinator.apiSecret): Promise<Response> {
    return fetch(`${config.coordinator.apiUrl}${route}`, {
        ...init,
        headers: {
            ...secret ? { 'Authorization': `Bearer ${secret}` } : {},
            'Content-Type': 'application/json'
        }
    });
}

/**
 * Asks the coordinator service to start an encounter, and returns its answer whatever it is.
 *
 * @param {string} hn - The patient's HN.
 * @returns {Promise<Object>} The HTTP status and the body.
 */
export async function postEncounter(hn: string): Promise<{ body: IEncounter; status: number; }> {
    const response = await callCoordinator('/encounters', { body: JSON.stringify({ hn }), method: 'POST' });

    return { body: await response.json() as IEncounter, status: response.status };
}

/**
 * Reads an encounter.
 *
 * @param {string} id - Its opaque id.
 * @returns {Promise<Object>} The HTTP status and the body.
 */
export async function getEncounter(id: string): Promise<{ body: IEncounter; status: number; }> {
    const response = await callCoordinator(`/encounters/${id}`);

    return { body: await response.json() as IEncounter, status: response.status };
}

/** A room as the API reports it. */
export interface IRoom {
    kind: 'lounge' | 'patient' | 'station';
    name: string;
    occupants: {
        displayName?: string;
        endpointId: string;
        identity?: { id?: string; name?: string; };
        role: 'hidden' | 'patient' | 'staff' | 'unknown';
    }[];
    open: boolean;
    stage?: string;
}

/**
 * Reads the open rooms.
 *
 * @returns {Promise<IRoom[]>}
 */
export async function getRooms(): Promise<IRoom[]> {
    const response = await callCoordinator('/rooms');

    if (!response.ok) {
        throw new Error(`GET /rooms failed with ${response.status}`);
    }

    return (await response.json() as { rooms: IRoom[]; }).rooms;
}

/**
 * Waits until the open rooms satisfy a condition.
 *
 * @param {Function} predicate - Receives the room of the patient's HN, if it is open.
 * @param {string} hn - The patient's HN.
 * @param {string} description - What is awaited, for the failure message.
 * @param {number} timeout - How long to wait, in milliseconds.
 * @returns {Promise<IRoom|undefined>} The room at that moment.
 */
export async function waitForRoom(
        predicate: (room?: IRoom) => boolean, hn: string, description: string, timeout = 30_000): Promise<IRoom | undefined> {
    const deadline = Date.now() + timeout;
    let seen: IRoom[] = [];

    for (;;) {
        seen = await getRooms();

        const room = seen.find(r => r.name === hn.toLowerCase());

        if (predicate(room)) {
            return room;
        }
        if (Date.now() > deadline) {
            throw new Error(`timed out waiting for ${description}; the rooms were ${JSON.stringify(seen)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/** A move as the API reports it. */
export interface IMove {
    id: string;
    reason?: string;
    state: 'cancelled' | 'counting_down' | 'done' | 'failed' | 'preparing' | 'refused';
}

/**
 * Asks the coordinator service to move a participant, and returns its answer whatever it is.
 *
 * @param {string} fromRoom - The room the participant is in, by the name the rooms API gives it.
 * @param {string} endpointId - The participant's endpoint id.
 * @param {string} toRoom - The destination room.
 * @returns {Promise<Object>} The HTTP status and the body.
 */
export async function postMove(fromRoom: string, endpointId: string, toRoom: string): Promise<{ body: IMove; status: number; }> {
    const response = await callCoordinator('/moves', {
        body: JSON.stringify({ from: { endpointId, room: fromRoom }, to: { room: toRoom } }),
        method: 'POST'
    });

    return { body: await response.json() as IMove, status: response.status };
}

/**
 * Waits until a move reaches a state.
 *
 * @param {string} id - The move's id.
 * @param {string} state - The state.
 * @param {number} timeout - How long to wait, in milliseconds.
 * @returns {Promise<IMove>}
 */
export async function waitForMove(id: string, state: IMove['state'], timeout = 60_000): Promise<IMove> {
    const deadline = Date.now() + timeout;

    for (;;) {
        const move = await (await callCoordinator(`/moves/${id}`)).json() as IMove;

        if (move.state === state) {
            return move;
        }
        if (Date.now() > deadline) {
            throw new Error(`the move was ${move.state}${move.reason ? ` (${move.reason})` : ''}, not ${state}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
}

/** One place in a stage's queue as the API reports it. */
export interface IQueueEntry {
    encounterId: string;
    hn?: string;
    suggested: boolean;
    waitedSeconds: number;
}

/**
 * Reads the queues of the stages.
 *
 * @returns {Promise<Record<string, IQueueEntry[]>>}
 */
export async function getQueues(): Promise<Record<string, IQueueEntry[]>> {
    return (await (await callCoordinator('/queues')).json() as { queues: Record<string, IQueueEntry[]>; }).queues;
}

/**
 * Puts an encounter in a stage.
 *
 * @param {string} id - The encounter's id.
 * @param {string} stage - The stage.
 * @returns {Promise<Object>} The HTTP status and the body.
 */
export async function postStage(id: string, stage: string): Promise<{ body: IEncounter & { history?: Array<{ stage: string; }>; }; status: number; }> {
    const response = await callCoordinator(`/encounters/${id}/stage`, { body: JSON.stringify({ stage }), method: 'POST' });

    return { body: await response.json(), status: response.status };
}

/**
 * Restarts the coordinator service's container and waits until its API answers.
 *
 * @returns {Promise<void>}
 */
export async function restartCoordinator(): Promise<void> {
    execFileSync('docker', [ 'restart', config.coordinator.container ?? '' ], { stdio: 'pipe' });
    await waitForCoordinator();
}

/**
 * Returns the address of the coordinator screen.
 *
 * @returns {string}
 */
export function screenUrl(): string {
    return `${config.coordinator.apiUrl}/screen`;
}

/** An audit entry as the API reports it. */
export interface IAuditEntry {
    at: string;
    destination?: string;
    encounterId?: string;
    issuer: string;
    kind: 'move' | 'stage';
    outcome: string;
    participantId?: string;
    reason?: string;
    source?: string;
}

/**
 * Reads the newest audit entries.
 *
 * @param {number} limit - How many.
 * @returns {Promise<IAuditEntry[]>}
 */
export async function getAudit(limit = 200): Promise<IAuditEntry[]> {
    return (await (await callCoordinator(`/audit?limit=${limit}`)).json() as { entries: IAuditEntry[]; }).entries;
}

/**
 * Stops the service, writes an old encounter and old and recent audit entries straight into its database, and starts
 * it again: its retention sweep then has something to delete, and something to leave.
 *
 * @param {Object} seed - What to write.
 * @param {string} seed.encounterId - The id of the old encounter.
 * @param {string} seed.oldParticipant - The participant of the old audit entry.
 * @param {string} seed.recentParticipant - The participant of the recent audit entry.
 * @returns {Promise<void>}
 */
export async function seedOldData(seed: { encounterId: string; oldParticipant: string; recentParticipant: string; }): Promise<void> {
    const container = config.coordinator.container ?? '';
    const volume = execFileSync('docker', [ 'inspect', '-f',
        '{{range .Mounts}}{{if eq .Destination "/var/lib/coordinator"}}{{.Name}}{{end}}{{end}}', container ], { encoding: 'utf8' }).trim();
    const script = `
        const { DatabaseSync } = require('node:sqlite');
        const db = new DatabaseSync('/var/lib/coordinator/coordinator.sqlite');
        const old = new Date(Date.now() - 100 * 86400000).toISOString();
        const recent = new Date(Date.now() - 86400000).toISOString();
        const seed = ${JSON.stringify(seed)};
        db.prepare('INSERT INTO encounters (id, hn, stage, started_at, stage_started_at, history) VALUES (?, ?, ?, ?, ?, ?)')
            .run(seed.encounterId, 'OLD-PATIENT', 'waiting', old, old, JSON.stringify([ { at: old, stage: 'waiting' } ]));
        for (const [ at, participantId ] of [ [ old, seed.oldParticipant ], [ recent, seed.recentParticipant ] ]) {
            db.prepare('INSERT INTO audit (at, entry) VALUES (?, ?)').run(at, JSON.stringify(
                { at, issuer: 'system', kind: 'move', outcome: 'done', participantId }));
        }
        db.close();`;

    execFileSync('docker', [ 'stop', container ], { stdio: 'pipe' });
    execFileSync('docker', [ 'run', '--rm', '--user', 'node', '--entrypoint', 'node', '-v', `${volume}:/var/lib/coordinator`,
        'coordinator:local', '--disable-warning=ExperimentalWarning', '-e', script ], { stdio: 'pipe' });
    execFileSync('docker', [ 'start', container ], { stdio: 'pipe' });
    await waitForCoordinator();
}

/**
 * Waits until the coordinator service's API answers.
 *
 * @returns {Promise<void>}
 */
async function waitForCoordinator(): Promise<void> {
    const deadline = Date.now() + 30_000;

    while (Date.now() < deadline) {
        try {
            if ((await callCoordinator('/health')).ok) {
                return;
            }
        } catch {
            // Not up yet.
        }
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    throw new Error('the coordinator service did not come back');
}

/**
 * Returns the service's log lines since a time.
 *
 * @param {Date} since - From when.
 * @returns {string}
 */
export function coordinatorLogs(since: Date): string {
    return execFileSync('docker', [ 'logs', '--since', since.toISOString(), config.coordinator.container ?? '' ],
        { encoding: 'utf8', stdio: [ 'ignore', 'pipe', 'pipe' ] });
}
