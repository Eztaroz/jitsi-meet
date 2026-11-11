import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import { MariaDbStore } from '../src/mariadbStore.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { createStandbyApi, waitUntilActive, watchActive } from '../src/standby.ts';
import type { IStore } from '../src/store.ts';

import { testMariaDb, wipeMariaDb } from './storeBackends.ts';

/**
 * A store that is only a lock: it can be taken after a number of tries, and lost.
 *
 * @param {number} takenOnTry - Which try gets the lock.
 * @returns {Object} The store, and how it was used.
 */
function lockOnly(takenOnTry: number) {
    const lock = { held: false, tries: 0 };
    const store = {
        acquireActive: () => {
            lock.tries++;
            lock.held = lock.tries >= takenOnTry;

            return lock.held;
        },
        holdsActive: () => lock.held
    } as unknown as IStore;

    return { lock, store };
}

describe('waiting to become the active instance', () => {
    it('stays standby, trying again, until the lock is free, then goes on', async () => {
        const { lock, store } = lockOnly(3);
        let waiting = 0;

        await waitUntilActive(store, { onStandby: () => waiting++, pollMs: 1 });

        assert.equal(lock.tries, 3);
        assert.equal(waiting, 1, 'says once that it is standby');
    });

    it('goes on at once when it takes the lock the first time', async () => {
        const { lock, store } = lockOnly(1);

        await waitUntilActive(store, { onStandby: () => assert.fail('was not standby'), pollMs: 1 });
        assert.equal(lock.tries, 1);
    });

    it('keeps trying when the database cannot be reached', async () => {
        let tries = 0;
        const store = {
            acquireActive: () => {
                if (++tries < 3) {
                    throw new Error('down');
                }

                return true;
            }
        } as unknown as IStore;

        await waitUntilActive(store, { pollMs: 1 });
        assert.equal(tries, 3);
    });
});

describe('watching that the lock is still held', () => {
    it('says so when the lock is lost, once', async () => {
        const { lock, store } = lockOnly(1);
        let lost = 0;

        store.acquireActive();

        const timer = watchActive(store, { intervalMs: 1, onLost: () => lost++ });

        await new Promise(resolve => setTimeout(resolve, 20));
        assert.equal(lost, 0);
        lock.held = false;
        await new Promise(resolve => setTimeout(resolve, 20));
        clearInterval(timer);
        assert.equal(lost, 1);
    });
});

describe('the API of a standby instance', () => {
    it('answers its health with that it is standby, and nothing else', async () => {
        const server = createStandbyApi('secret');

        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

        const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

        try {
            const health = await fetch(`${base}/health`, { headers: { authorization: 'Bearer secret' } });

            assert.equal(health.status, 503);
            assert.deepEqual(await health.json(), { active: false, status: 'standby' });
            assert.equal((await fetch(`${base}/health`)).status, 401);
            assert.equal((await fetch(`${base}/encounters`, { headers: { authorization: 'Bearer secret' } })).status, 503);
        } finally {
            server.close();
            server.closeAllConnections();
        }
    });
});

const mariadb = testMariaDb();

describe('two coordinator services on one MariaDB', { skip: !mariadb && 'COORDINATOR_TEST_MARIADB is not set' }, () => {
    it('keeps the second one standby, then active with the same state when the first stops', async () => {
        await wipeMariaDb(mariadb!);

        const first = new MariaDbStore(mariadb!);
        const second = new MariaDbStore(mariadb!);
        const make = (store: IStore) => new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: { recordRoom: async (hn: string) => `c-${hn}` } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey: generateKeyPairSync('rsa', {
                modulusLength: 2048,
                privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
                publicKeyEncoding: { format: 'pem', type: 'spki' }
            }).privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });

        try {
            assert.equal(first.acquireActive(), true);
            assert.equal(second.acquireActive(), false);

            const active = make(first);
            const started = await active.startEncounter('HN/1');

            active.stop();
            first.close();

            const standby = new Promise<void>((resolve, reject) => {
                waitUntilActive(second, { pollMs: 5 }).then(resolve, reject);
            });

            await standby;

            const taken = make(second);

            taken.stop();
            assert.deepEqual(taken.state.encounters.map(e => e.id), [ started.encounter?.id ]);
        } finally {
            first.close();
            second.close();
        }
    });
});
