/**
 * One active coordinator service at a time (ADR 0015). Every instance opens the same MariaDB and tries for a named
 * lock; the one that holds it is active, the others wait as standby and take over when it is gone. While standby an
 * instance has no state in memory and does nothing but answer its health check, so that the one taking over reads the
 * state the active one wrote.
 */
import { type Server, createServer } from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';

import { sameSecret } from './api.ts';
import { send } from './http.ts';
import { log } from './log.ts';
import type { IStore } from './store.ts';

/** How often a standby instance tries for the lock, and an active one checks that it still has it. */
export const LOCK_POLL_MS = 2000;

/**
 * Waits until this instance holds the active place.
 *
 * @param {IStore} store - The store; its lock is the place.
 * @param {Object} [options] - Options.
 * @param {Function} [options.onStandby] - Called once, when the first try found another instance active.
 * @param {number} [options.pollMs] - How long to wait between tries.
 * @returns {Promise<void>}
 */
export async function waitUntilActive(store: IStore, { onStandby, pollMs = LOCK_POLL_MS }: {
    onStandby?: () => void;
    pollMs?: number;
} = {}): Promise<void> {
    let announced = false;

    for (;;) {
        try {
            if (store.acquireActive()) {
                return;
            }
        } catch (error) {
            // The database cannot be reached: this instance cannot be active, and tries again.
            log.warn('cannot try for the active place', { reason: (error as Error).message });
        }
        if (!announced) {
            announced = true;
            onStandby?.();
        }
        await sleep(pollMs);
    }
}

/**
 * Checks now and then that this instance still holds the active place, and says so, once, when it does not. A lost
 * place means another instance may be active: the caller stops, and starts again as standby.
 *
 * @param {IStore} store - The store.
 * @param {Object} options - Options.
 * @param {number} [options.intervalMs] - How often.
 * @param {Function} options.onLost - Called once.
 * @returns {NodeJS.Timeout} The timer; clear it to stop watching.
 */
export function watchActive(store: IStore, { intervalMs = LOCK_POLL_MS, onLost }: {
    intervalMs?: number;
    onLost: () => void;
}): NodeJS.Timeout {
    let reported = false;
    const timer = setInterval(() => {
        if (!reported && !store.holdsActive()) {
            reported = true;
            onLost();
        }
    }, intervalMs);

    timer.unref();

    return timer;
}

/**
 * Makes the API of a standby instance: its health says it is standby, and everything else is refused.
 *
 * @param {string} secret - The shared bearer secret, which its health asks for as the active one's does.
 * @returns {Server}
 */
export function createStandbyApi(secret: string): Server {
    return createServer((req, res) => {
        const [ scheme, token ] = (req.headers.authorization ?? '').split(' ');
        const { pathname } = new URL(req.url ?? '/', 'http://localhost');

        if (pathname === '/health' && req.method === 'GET') {
            if (scheme !== 'Bearer' || !token || !sameSecret(token, secret)) {
                res.setHeader('www-authenticate', 'Bearer');
                send(res, 401, { error: 'missing or wrong bearer secret' });
            } else {
                send(res, 503, { active: false, status: 'standby' });
            }

            return;
        }
        send(res, 503, { error: 'this instance is standby; the active one answers' });
    });
}
