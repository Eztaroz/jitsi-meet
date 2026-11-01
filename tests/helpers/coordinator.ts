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

/**
 * Restarts the coordinator service's container and waits until its API answers.
 *
 * @returns {Promise<void>}
 */
export async function restartCoordinator(): Promise<void> {
    execFileSync('docker', [ 'restart', config.coordinator.container ?? '' ], { stdio: 'pipe' });

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
