import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import { DatabaseError } from '../src/mariadbClient.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import type { StoreChange } from '../src/stateChanges.ts';
import { Store } from '../src/store.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

/** A store whose database can be made to refuse every write, the way a MariaDB that went away does. */
class FlakyStore extends Store {
    down = false;

    override apply(changes: StoreChange[]): void {
        if (this.down) {
            throw new DatabaseError('the database is down');
        }
        super.apply(changes);
    }

    override checkWritable(): void {
        if (this.down) {
            throw new DatabaseError('the database is down');
        }
        super.checkWritable();
    }
}

describe('the API while the database cannot be written', () => {
    let base: string;
    let holds: boolean;
    let moved: string[];
    let recorded: string[];
    let server: Server;
    let service: CoordinatorService;
    let store: FlakyStore;

    /**
     * Calls the API with the shared secret.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {unknown} [body] - The JSON body.
     * @returns {Promise<Object>} The status and the JSON answer.
     */
    async function call(method: string, path: string, body?: unknown): Promise<{ body: any; status: number; }> {
        const response = await fetch(`${base}${path}`, {
            body: body === undefined ? undefined : JSON.stringify(body),
            headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
            method
        });

        return { body: await response.json(), status: response.status };
    }

    beforeEach(async () => {
        holds = true;
        moved = [];
        recorded = [];
        store = new FlakyStore(mkdtempSync(join(tmpdir(), 'down-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
            prosody: {
                rooms: async () => ({ rooms: [
                    { name: 'a', occupants: [ { endpointId: 'e1', hidden: false, identity: { user: { hospital_role: 'staff', id: 's1' } } } ] },
                    { name: 'b', occupants: [] }
                ] }),
                sendMove: async ({ endpointId }: { endpointId: string; }) => {
                    moved.push(endpointId);
                }
            } as unknown as Prosody,
            recorderBot: {
                recordRoom: async (hn: string) => {
                    recorded.push(hn);

                    return `c-${hn}`;
                }
            } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
        server = createApi({ holdsLock: () => holds, secret: SECRET, service });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    });

    it('refuses to start an encounter with an error the caller can show, and does nothing', async () => {
        store.down = true;

        const refused = await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal(refused.status, 503);
        assert.equal(refused.body.error, 'the database cannot be written now; nothing was done');
        assert.deepEqual(recorded, [], 'the recorder bot was not asked to record');
        assert.equal(service.state.encounters.length, 0);

        store.down = false;
        assert.equal((await call('POST', '/encounters', { hn: 'HN/1' })).status, 201);
    });

    it('refuses to change a stage, and the encounter stays where it was', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        store.down = true;

        const refused = await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'intake' });

        assert.equal(refused.status, 503);
        assert.equal(service.state.encounters[0].stage, 'waiting');

        store.down = false;
        assert.equal(store.load().encounters[0].stage, 'waiting');
        assert.equal(store.audit(10).length, 0, 'no audit entry for what was not done');
        assert.equal((await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'intake' })).status, 200);
    });

    it('refuses a move, and sends nobody anywhere', async () => {
        store.down = true;

        const refused = await call('POST', '/moves', { from: { endpointId: 'e1', room: 'a' }, to: { room: 'b' } });

        assert.equal(refused.status, 503);
        assert.deepEqual(moved, []);
        assert.equal(service.state.moves.length, 0);
    });

    it('keeps its state in memory the same as the database when a write is refused half way', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        // The probe passes but the write itself is refused.
        const apply = store.apply.bind(store);

        store.apply = () => {
            throw new DatabaseError('refused');
        };

        const refused = await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'intake' });

        store.apply = apply;
        assert.equal(refused.status, 503);
        assert.equal(service.state.encounters[0].stage, 'waiting');
    });

    it('says in its health whether it holds the active lock', async () => {
        assert.deepEqual((await call('GET', '/health')).body, { active: true, openEncounters: 0, status: 'ok' });

        holds = false;

        const standby = await call('GET', '/health');

        assert.equal(standby.status, 503);
        assert.equal(standby.body.active, false);
        assert.equal(standby.body.status, 'standby');
    });
});
