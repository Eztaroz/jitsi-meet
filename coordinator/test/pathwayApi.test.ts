import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const SECRET = 'system-secret';
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const layout: ILayout = {
    centers: [ {
        clinics: [ { id: 'gyn', pathway: 'short' } ],
        id: 'c1',
        pathways: [ { id: 'short', stages: [ { id: 'waiting', name: 'W' }, { id: 'done', name: 'D' } ] } ],
        stations: []
    } ]
};

describe('the hospital system\'s API for encounters and pathways', () => {
    let base: string;
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    before(async () => {
        store = new Store(mkdtempSync(join(tmpdir(), 'pathway-api-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout,
            prosody: { rooms: async () => ({ rooms: [] }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
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
    });

    after(() => {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    });

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

    it('starts an encounter with a visit number, center and clinic, and reads them back with the pathway', async () => {
        const started = await call('POST', '/encounters', { center: 'c1', clinic: 'gyn', hn: 'HN/1', visitNumber: 'VN-1' });
        const read = await call('GET', `/encounters/${started.body.id}`);

        assert.equal(started.status, 201);
        assert.deepEqual([ read.body.pathway, read.body.visitNumber, read.body.center, read.body.clinic ],
            [ 'short', 'VN-1', 'c1', 'gyn' ]);
    });

    it('starts an encounter with only an HN, as before', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/2' });

        assert.equal(started.status, 201);
        assert.equal((await call('GET', `/encounters/${started.body.id}`)).body.pathway, 'default');
    });

    it('refuses an unknown center or clinic', async () => {
        const center = await call('POST', '/encounters', { center: 'nope', hn: 'HN/3' });
        const clinic = await call('POST', '/encounters', { clinic: 'nope', hn: 'HN/3' });
        const badVisit = await call('POST', '/encounters', { hn: 'HN/3', visitNumber: 7 });

        assert.deepEqual([ center.status, clinic.status, badVisit.status ], [ 400, 400, 400 ]);
        assert.match(center.body.error, /center/u);
        assert.match(clinic.body.error, /clinic/u);
    });

    it('refuses a stage outside the encounter\'s pathway, and accepts one inside it', async () => {
        const started = await call('POST', '/encounters', { clinic: 'gyn', hn: 'HN/4' });
        const outside = await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'examination' });
        const inside = await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'done' });

        assert.equal(outside.status, 400);
        assert.match(outside.body.error, /pathway/u);
        assert.equal(inside.status, 200);
        assert.equal(inside.body.stage, 'done');
    });

    it('names the stages of the history by the pathway', async () => {
        const started = await call('POST', '/encounters', { hn: 'HN/5' });

        await call('POST', `/encounters/${started.body.id}/stage`, { stage: 'billing' });

        const history = (await call('GET', `/encounters/${started.body.id}`)).body.history;

        assert.deepEqual(history.map((h: { name: string; stage: string; }) => [ h.stage, h.name ]).at(-1), [ 'billing', 'ชำระเงิน' ]);
    });

    it('lists a queue for each stage of the configured pathways', async () => {
        const { body } = await call('GET', '/queues');

        assert.ok(Object.keys(body.queues).includes('pharmacy'));
        assert.ok(!Object.keys(body.queues).includes('done'));
    });
});
