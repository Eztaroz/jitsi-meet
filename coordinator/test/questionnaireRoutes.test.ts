import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import type { CoordinatorService } from '../src/coordinatorService.ts';
import { signToken } from '../src/jwt.ts';
import type { ISentQuestionnaire } from '../src/questionnaires.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import type { ICoordinatorAuth } from '../src/screenAuth.ts';

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

const QUESTIONS = [ { choices: [ 'Yes', 'No' ] as [string, string], text: 'Does it hurt?' } ];

/**
 * Starts the API with a service that only knows questionnaires.
 *
 * @returns {Promise<Object>}
 */
async function start() {
    const calls: unknown[][] = [];
    const sent: ISentQuestionnaire = {
        id: 'sent-1', questionnaire: 'pain', questions: QUESTIONS, sentAt: new Date(), sentBy: 'system',
        staffAtSend: [], title: 'Pain'
    };
    const service = {
        answerQuestionnaire: async (identityId: string, id: string, answers: unknown) => {
            calls.push([ 'answer', identityId, id, answers ]);

            return id === 'gone' ? { refused: 'unknown_questionnaire' } : Array.isArray(answers) ? {} : { refused: 'invalid_answers' };
        },
        pendingQuestionnaire: async (identityId: string) => identityId === 'p-1'
            ? { id: 'sent-1', questions: QUESTIONS, title: 'Pain' }
            : undefined,
        questionnaireCatalogue: () => [ { id: 'pain', questions: QUESTIONS, title: 'Pain' } ],
        questionnairesOf: (id: string) => id === 'e-1' ? [ sent ] : undefined,
        sendQuestionnaire: async (encounterId: string, questionnaire: string, by: string) => {
            calls.push([ 'send', encounterId, questionnaire, by ]);

            if (encounterId === 'missing') {
                return { refused: 'unknown_encounter' };
            }
            if (encounterId === 'closed') {
                return { refused: 'encounter_closed' };
            }

            return questionnaire === 'pain' ? { sent } : { refused: 'unknown_questionnaire' };
        }
    } as unknown as CoordinatorService;
    const server: Server = createApi({
        secret: SECRET,
        service,
        survey: { ...issuer, marker: parseRoleMarker('user.hospital_role=patient', 'X') as never }
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, calls, server };
}

describe('the health questionnaire routes', () => {
    let api: Awaited<ReturnType<typeof start>>;
    const patient = (path = '/questionnaire', init: RequestInit = {}, as = token('patient', 'p-1')) =>
        fetch(`${api.base}${path}`, { ...init, headers: { authorization: `Bearer ${as}`, 'content-type': 'application/json' } });
    const system = (path: string, init: RequestInit = {}) =>
        fetch(`${api.base}${path}`, { ...init, headers: { authorization: `Bearer ${SECRET}`, 'content-type': 'application/json' } });

    before(async () => {
        api = await start();
    });

    after(() => {
        api.server.close();
    });

    it('shows a patient what is waiting for them, and nothing when nothing is', async () => {
        const waiting = await patient();
        const none = await patient('/questionnaire', {}, token('patient', 'p-2'));

        assert.equal(waiting.status, 200);
        assert.deepEqual(await waiting.json(), { questionnaire: { id: 'sent-1', questions: QUESTIONS, title: 'Pain' } });
        assert.deepEqual(await none.json(), { questionnaire: null });
    });

    it('is a patient\'s: staff tokens, the shared secret and no token are turned away', async () => {
        assert.equal((await patient('/questionnaire', {}, token('staff', 's-1'))).status, 403);
        assert.equal((await patient('/questionnaire', {}, SECRET)).status, 403);
        assert.equal((await fetch(`${api.base}/questionnaire`)).status, 401);
    });

    it('keeps a patient\'s answers under their verified identity', async () => {
        const response = await patient('/questionnaire', { body: JSON.stringify({ answers: [ 1 ], id: 'sent-1' }), method: 'POST' });

        assert.equal(response.status, 200);
        assert.deepEqual(api.calls.at(-1), [ 'answer', 'p-1', 'sent-1', [ 1 ] ]);
    });

    it('refuses answers that do not fit, and a questionnaire that is not waiting', async () => {
        const bad = await patient('/questionnaire', { body: JSON.stringify({ answers: 'yes', id: 'sent-1' }), method: 'POST' });
        const gone = await patient('/questionnaire', { body: JSON.stringify({ answers: [ 1 ], id: 'gone' }), method: 'POST' });
        const noId = await patient('/questionnaire', { body: JSON.stringify({ answers: [ 1 ] }), method: 'POST' });

        assert.equal(bad.status, 400);
        assert.equal(gone.status, 404);
        assert.equal(noId.status, 400);
    });

    it('lets the hospital\'s system send a questionnaire, and audits it under "system"', async () => {
        const response = await system('/encounters/e-1/questionnaires', { body: JSON.stringify({ questionnaire: 'pain' }), method: 'POST' });

        assert.equal(response.status, 201);
        assert.deepEqual(await response.json(), { id: 'sent-1' });
        assert.deepEqual(api.calls.at(-1), [ 'send', 'e-1', 'pain', 'system' ]);
    });

    it('refuses a sending to an unknown or closed encounter, or of an unknown questionnaire', async () => {
        const send = (id: string, questionnaire: string) => system(`/encounters/${id}/questionnaires`,
            { body: JSON.stringify({ questionnaire }), method: 'POST' });

        assert.equal((await send('missing', 'pain')).status, 404);
        assert.equal((await send('closed', 'pain')).status, 409);
        assert.equal((await send('e-1', 'nope')).status, 400);
        assert.equal((await system('/encounters/e-1/questionnaires', { body: '{}', method: 'POST' })).status, 400);
    });

    it('reads the answers of one encounter, and the catalogue', async () => {
        const answers = await system('/encounters/e-1/questionnaires');
        const none = await system('/encounters/missing/questionnaires');
        const catalogue = await system('/questionnaires');

        assert.equal(answers.status, 200);
        assert.deepEqual(((await answers.json()) as { questionnaires: { id: string; }[]; }).questionnaires.map(q => q.id), [ 'sent-1' ]);
        assert.equal(none.status, 404);
        assert.deepEqual(await catalogue.json(), { questionnaires: [ { id: 'pain', questions: QUESTIONS, title: 'Pain' } ] });
    });
});
