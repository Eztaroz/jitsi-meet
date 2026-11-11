import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, test } from 'node:test';

import { createApi } from '../src/api.ts';
import type { Consultations } from '../src/consultations.ts';

const SECRET = 'test-secret';

describe('starting a consultation', () => {
    const started: string[] = [];
    const fake = {
        active: () => [],
        start: (hn: string, consultationId: string) => {
            started.push(`${hn}/${consultationId}`);

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

    for (const body of [ { hn: '123' }, { consultationId: '', hn: '123' }, { consultationId: 7, hn: '123' },
        { consultationId: '../x', hn: '123' }, { consultationId: 'a/b', hn: '123' } ]) {
        test(`refuses ${JSON.stringify(body)} as it has no usable consultation id`, async () => {
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
