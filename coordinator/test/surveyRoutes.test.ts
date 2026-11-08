import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import type { CoordinatorService } from '../src/coordinatorService.ts';
import { signToken } from '../src/jwt.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import type { ICoordinatorAuth } from '../src/screenAuth.ts';
import type { ISurveyAnswers } from '../src/surveys.ts';

const SECRET = 'system-secret';
const hospital = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const issuer: Omit<ICoordinatorAuth, 'marker'> = {
    acceptedAudiences: [ 'jitsi' ],
    acceptedIssuers: [ 'chat' ],
    keyFor: async kid => kid === 'hospital/key' ? hospital.publicKey : undefined
};

/**
 * Signs a token of the hospital's issuer for someone with a role.
 *
 * @param {string} role - The hospital_role claim.
 * @param {string} id - The verified identity id.
 * @returns {string}
 */
function token(role: string, id: string): string {
    return signToken({
        claims: {
            aud: 'jitsi',
            context: { user: { hospital_role: role, id } },
            exp: Math.floor(Date.now() / 1000) + 3600,
            iss: 'chat'
        },
        kid: 'hospital/key',
        privateKey: hospital.privateKey
    });
}

/**
 * Starts the API with a service that only keeps surveys.
 *
 * @param {boolean} withSurvey - Whether the deployment has the survey.
 * @returns {Promise<Object>}
 */
async function start(withSurvey = true) {
    const kept: { answers: ISurveyAnswers; identityId: string; }[] = [];
    const exports: { from: Date; issuer: string; to: Date; }[] = [];
    const service = {
        addSurvey: (identityId: string, answers: ISurveyAnswers) => {
            kept.push({ answers, identityId });

            return { id: `s-${kept.length}` };
        },
        surveyReport: (from: Date, to: Date, by: string) => {
            exports.push({ from, issuer: by, to });

            return '﻿submitted_at\r\n';
        }
    } as unknown as CoordinatorService;
    const server: Server = createApi({
        secret: SECRET,
        service,
        survey: withSurvey
            ? { ...issuer, marker: parseRoleMarker('user.hospital_role=patient', 'X') as never }
            : undefined
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, exports, kept, server };
}

describe('the satisfaction survey routes', () => {
    let api: Awaited<ReturnType<typeof start>>;
    const post = (body: unknown, bearer = token('patient', 'p-1')) => fetch(`${api.base}/survey`, {
        body: JSON.stringify(body),
        headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/json' },
        method: 'POST'
    });

    before(async () => {
        api = await start();
    });

    after(() => {
        api.server.close();
    });

    it('tells a patient\'s page that it can ask', async () => {
        const response = await fetch(`${api.base}/survey`, { headers: { authorization: `Bearer ${token('patient', 'p-9')}` } });

        assert.equal(response.status, 200);
    });

    it('turns away a staff member\'s token and a request without a token', async () => {
        const staff = await fetch(`${api.base}/survey`, { headers: { authorization: `Bearer ${token('staff', 's-1')}` } });
        const none = await fetch(`${api.base}/survey`);

        assert.equal(staff.status, 403);
        assert.deepEqual(await staff.json(), { error: 'not_a_patient' });
        assert.equal(none.status, 401);
    });

    it('turns away the shared secret: a survey is a patient\'s', async () => {
        assert.equal((await post({ rating: 5, room: 'a' }, SECRET)).status, 403);
    });

    it('keeps a patient\'s answers under their verified identity', async () => {
        const response = await post({ rating: 4, room: '6512345', tags: [ 'kind' ] });

        assert.equal(response.status, 201);
        assert.deepEqual(api.kept.at(-1), {
            answers: { aspects: {}, comment: undefined, rating: 4, room: '6512345', tags: [ 'kind' ] },
            identityId: 'p-1'
        });
    });

    it('refuses answers that are not a survey', async () => {
        assert.equal((await post({ rating: 9, room: 'a' }, token('patient', 'p-2'))).status, 400);
    });

    it('refuses a second survey from the same patient straight after the first', async () => {
        assert.equal((await post({ rating: 5, room: 'a' }, token('patient', 'p-3'))).status, 201);
        assert.equal((await post({ rating: 5, room: 'a' }, token('patient', 'p-3'))).status, 429);
    });

    it('exports the report as a CSV file, for the shared secret only', async () => {
        const url = `${api.base}/surveys.csv?from=2030-01-01T00:00:00%2B07:00&to=2030-01-31T23:59:59%2B07:00`;
        const report = await fetch(url, { headers: { authorization: `Bearer ${SECRET}` } });
        const asPatient = await fetch(url, { headers: { authorization: `Bearer ${token('patient', 'p-1')}` } });

        assert.equal(report.status, 200);
        assert.equal(report.headers.get('content-type'), 'text/csv; charset=utf-8');
        assert.match(report.headers.get('content-disposition') ?? '', /attachment; filename="surveys\.csv"/u);
        assert.deepEqual(api.exports.at(-1), {
            from: new Date('2029-12-31T17:00:00Z'), issuer: 'system', to: new Date('2030-01-31T16:59:59Z')
        });
        assert.equal(asPatient.status, 401);
    });

    it('refuses a report period it cannot read', async () => {
        const response = await fetch(`${api.base}/surveys.csv?from=yesterday`, { headers: { authorization: `Bearer ${SECRET}` } });

        assert.equal(response.status, 400);
    });
});

describe('a deployment without the survey', () => {
    it('has no survey route', async () => {
        const api = await start(false);

        try {
            const response = await fetch(`${api.base}/survey`, { headers: { authorization: `Bearer ${token('patient', 'p-1')}` } });

            assert.equal(response.status, 404);
        } finally {
            api.server.close();
        }
    });
});
