import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { createApi } from '../src/api.ts';
import type { Consultations } from '../src/consultations.ts';

const SECRET = 'test-secret';

describe('starting a consultation', () => {
    const started: string[] = [];
    const options: unknown[] = [];
    const fake = {
        active: () => [],
        start: (hn: string, consultationId: string, given?: unknown) => {
            started.push(`${hn}/${consultationId}`);
            options.push(given);

            return { consultation: { snapshot: () => ({ consultationId, status: 'starting' }) }, created: true };
        }
    } as unknown as Consultations;
    const server = createApi({ consultations: fake, maxConsultations: 2, secret: SECRET });
    let base = '';

    before(async () => {
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });
    after(() => {
        server.close();
    });

    /**
     * Posts a body to the consultations endpoint.
     *
     * @param {unknown} body - The body.
     * @returns {Promise<Response>}
     */
    function post(body: unknown) {
        return fetch(`${base}/consultations`, {
            body: JSON.stringify(body),
            headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' },
            method: 'POST'
        });
    }

    test('starts the consultation under the id it is given', async () => {
        const res = await post({ consultationId: 'made-by-coordinator', hn: '123' });

        assert.equal(res.status, 201);
        assert.deepEqual(started, [ '123/made-by-coordinator' ]);
        assert.equal(((await res.json()) as { consultationId: string; }).consultationId, 'made-by-coordinator');
    });

    test('passes on when the consultation started and, for a takeover, where its gap starts (ADR 0016)', async () => {
        options.length = 0;

        const res = await post({
            consultationId: 'c9', gapSince: '2026-05-01T08:29:50.000Z', hn: '123', startedAt: '2026-05-01T08:00:00.000Z'
        });

        assert.equal(res.status, 201);
        assert.deepEqual(options, [ {
            gapSince: new Date('2026-05-01T08:29:50.000Z'), startedAt: new Date('2026-05-01T08:00:00.000Z')
        } ]);
    });

    test('passes on the lost worker a takeover comes from, and refuses one that is not an id', async () => {
        options.length = 0;
        assert.equal((await post({ consultationId: 'c6', hn: '123', takenFrom: 'bot-1' })).status, 201);
        assert.deepEqual(options, [ { takenFrom: 'bot-1' } ]);
        assert.equal((await post({ consultationId: 'c5', hn: '123', takenFrom: 5 })).status, 400);
    });

    test('starts without them, and refuses a time that is not one', async () => {
        options.length = 0;
        assert.equal((await post({ consultationId: 'c8', hn: '123' })).status, 201);
        assert.deepEqual(options, [ {} ]);
        assert.equal((await post({ consultationId: 'c7', hn: '123', startedAt: 'yesterday' })).status, 400);
        assert.equal((await post({ consultationId: 'c7', gapSince: 5, hn: '123' })).status, 400);
    });

    test('makes an id itself for an older coordinator service that sends none, so a new worker serves it until the night deployment', async () => {
        started.length = 0;

        const res = await post({ hn: '123' });
        const { consultationId } = await res.json() as { consultationId: string; };

        assert.equal(res.status, 201);
        assert.match(consultationId, /^[0-9a-f-]{36}$/u);
        assert.deepEqual(started, [ `123/${consultationId}` ]);
    });

    for (const body of [ { consultationId: '', hn: '123' }, { consultationId: 7, hn: '123' },
        { consultationId: '../x', hn: '123' }, { consultationId: 'a/b', hn: '123' } ]) {
        test(`refuses ${JSON.stringify(body)} as it names an unusable consultation id`, async () => {
            started.length = 0;

            const res = await post(body);
            const { error } = await res.json() as { error: string; };

            assert.equal(res.status, 400);
            assert.match(error, /consultationId/);
            assert.deepEqual(started, []);
        });
    }

    for (const fields of [ { room: 'station-1' }, { patient: 'p@hospital' }, { room: 'station-1', patient: 'p@hospital' } ]) {
        test(`refuses station fields ${Object.keys(fields).join(' and ')}, pointing to ADR 0011`, async () => {
            started.length = 0;

            const res = await post({ consultationId: 'c1', hn: '123', ...fields });
            const { error } = await res.json() as { error: string; };

            assert.equal(res.status, 400);
            assert.match(error, /station/);
            assert.match(error, /ADR 0011/);
            assert.deepEqual(started, []);
        });
    }
});
