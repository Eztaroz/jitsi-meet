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

describe('per-doctor examination queues', () => {
    let dir: string;
    let base: string;
    let server: Server;
    let service: CoordinatorService;
    let store: Store;

    /**
     * Opens a service and its API on the directory, as a restart would.
     *
     * @returns {Promise<void>}
     */
    async function open(): Promise<void> {
        store = new Store(dir);
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
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
    }

    /**
     * Closes the service and its API.
     *
     * @returns {void}
     */
    function close(): void {
        service.stop();
        server.close();
        server.closeAllConnections();
        store.close();
    }

    beforeEach(async () => {
        dir = mkdtempSync(join(tmpdir(), 'doctors-'));
        await open();
    });

    afterEach(close);

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

    /**
     * Starts an encounter and puts it in examination.
     *
     * @param {string} hn - The HN.
     * @returns {Promise<string>} The encounter's id.
     */
    async function inExamination(hn: string): Promise<string> {
        const { body } = await call('POST', '/encounters', { hn });

        await call('POST', `/encounters/${body.id}/stage`, { stage: 'examination' });

        return body.id;
    }

    it('lists an encounter in examination with no doctor as unassigned', async () => {
        const id = await inExamination('HN/1');
        const { body } = await call('GET', '/queues');

        assert.deepEqual(body.examination.unassigned.map((e: { encounterId: string; }) => e.encounterId), [ id ]);
        assert.deepEqual(body.examination.doctors, {});
    });

    it('lets the hospital\'s system set a doctor, and splits examination by doctor, longest-waiting first', async () => {
        const a = await inExamination('HN/1');
        const b = await inExamination('HN/2');
        const c = await inExamination('HN/3');
        const d = await inExamination('HN/4');

        assert.equal((await call('POST', `/encounters/${a}/doctor`, { doctor: 'dr-x' })).status, 200);
        await call('POST', `/encounters/${b}/doctor`, { doctor: 'dr-y' });
        await call('POST', `/encounters/${c}/doctor`, { doctor: 'dr-x' });

        const { examination } = (await call('GET', '/queues')).body;
        const ids = (entries: { encounterId: string; }[]) => entries.map(e => e.encounterId);

        assert.deepEqual(ids(examination.doctors['dr-x']), [ a, c ]);
        assert.equal(examination.doctors['dr-x'][0].suggested, true);
        assert.equal(examination.doctors['dr-x'][1].suggested, false);
        assert.deepEqual(ids(examination.doctors['dr-y']), [ b ]);
        assert.deepEqual(ids(examination.unassigned), [ d ]);
        assert.equal((await call('GET', `/encounters/${a}`)).body.doctor, 'dr-x');
    });

    it('changes a doctor, and clears it with null', async () => {
        const id = await inExamination('HN/1');

        await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-x' });
        await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-y' });

        const moved = (await call('GET', '/queues')).body.examination;

        assert.deepEqual(Object.keys(moved.doctors), [ 'dr-y' ]);

        await call('POST', `/encounters/${id}/doctor`, { doctor: null });

        const cleared = (await call('GET', '/queues')).body.examination;

        assert.deepEqual(cleared.doctors, {});
        assert.equal(cleared.unassigned.length, 1);
    });

    it('refuses an unknown encounter, a closed one and a bad doctor', async () => {
        const id = await inExamination('HN/1');
        const unknown = await call('POST', '/encounters/nope/doctor', { doctor: 'dr-x' });
        const bad = await call('POST', `/encounters/${id}/doctor`, { doctor: 7 });
        const missing = await call('POST', `/encounters/${id}/doctor`, {});

        await call('POST', `/encounters/${id}/stage`, { stage: 'done' });

        const closed = await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-x' });

        assert.deepEqual([ unknown.status, bad.status, missing.status, closed.status ], [ 404, 400, 400, 409 ]);
    });

    it('audits each doctor change with who made it, and each refusal', async () => {
        const id = await inExamination('HN/1');

        await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-x' });
        await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-y' });
        await call('POST', '/encounters/nope/doctor', { doctor: 'dr-x' });

        const entries = service.audit(10).filter(e => e.kind === 'doctor');

        assert.deepEqual(entries.map(e => [ e.issuer, e.outcome, e.doctor, e.previousDoctor, e.reason ]), [
            [ 'system', 'refused', 'dr-x', undefined, 'unknown_encounter' ],
            [ 'system', 'ok', 'dr-y', 'dr-x', undefined ],
            [ 'system', 'ok', 'dr-x', undefined, undefined ]
        ]);
    });

    it('keeps the doctor across a restart', async () => {
        const id = await inExamination('HN/1');

        await call('POST', `/encounters/${id}/doctor`, { doctor: 'dr-x' });
        close();
        await open();

        assert.equal((await call('GET', `/encounters/${id}`)).body.doctor, 'dr-x');
    });
});
