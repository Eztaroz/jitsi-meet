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
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

describe('the coordinator service makes each consultation\'s id and keeps its consultations', () => {
    let asked: { consultationId: string; hn: string; }[];
    let base: string;
    let dir: string;
    let refuse: boolean;
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    /**
     * Starts the service and its API on the directory's store, over a fake recorder bot that echoes the id it is given.
     *
     * @returns {Promise<void>}
     */
    async function boot(): Promise<void> {
        store = new Store(dir);
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: {
                recordRoom: async (hn: string, consultationId: string) => {
                    if (refuse) {
                        throw new Error('refused');
                    }
                    asked.push({ consultationId, hn });

                    return consultationId;
                },
                workerId: 'bot-1'
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
        server = createApi({ secret: SECRET, service });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }

    /**
     * Stops the service and its API.
     *
     * @returns {void}
     */
    function shutDown(): void {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    }

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
        asked = [];
        refuse = false;
        dir = mkdtempSync(join(tmpdir(), 'consultations-'));
        await boot();
    });

    afterEach(() => shutDown());

    it('opens the patient\'s room with an id it made, and finds the consultation from the encounter', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/1' });
        const found = await call('GET', `/encounters/${started.body.id}/consultations`);

        assert.equal(started.status, 201);
        assert.equal(asked.length, 1);
        assert.equal(asked[0].hn, 'HN/1');
        assert.match(asked[0].consultationId, /^[0-9a-f-]{36}$/u);
        assert.deepEqual(found.body.consultations.map((c: any) => [ c.id, c.recorderBot, c.recording ]),
            [ [ asked[0].consultationId, 'bot-1', true ] ]);
        assert.ok(!JSON.stringify(found.body).includes('HN/1'), 'the HN is not in the consultation');
    });

    it('makes a different id for each consultation, and asks for none again while the encounter is open', async () => {
        const a = await call('POST', '/encounters', { hn: 'HN/1' });
        const b = await call('POST', '/encounters', { hn: 'HN/2' });

        await call('POST', '/encounters', { hn: 'HN/1' });

        assert.equal(asked.length, 2);
        assert.notEqual(asked[0].consultationId, asked[1].consultationId);
        assert.equal((await call('GET', `/encounters/${a.body.id}/consultations`)).body.consultations.length, 1);
        assert.equal((await call('GET', `/encounters/${b.body.id}/consultations`)).body.consultations[0].id,
            asked[1].consultationId);
    });

    it('keeps the consultations across a restart', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/1' });

        shutDown();
        await boot();

        const found = await call('GET', `/encounters/${started.body.id}/consultations`);

        assert.deepEqual(found.body.consultations.map((c: any) => c.id), [ asked[0].consultationId ]);
    });

    it('keeps nothing when the recorder bot refused the room', async () => {
        refuse = true;

        const started = await call('POST', '/encounters', { hn: 'HN/9' });

        assert.equal(started.status, 500);
        assert.equal(service.state.encounters.length, 0);
    });

    it('answers 404 for an encounter it does not know', async () => {
        assert.equal((await call('GET', '/encounters/nope/consultations')).status, 404);
    });
});
