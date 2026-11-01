import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { signToken } from '../src/jwt.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { type ICoordinatorAuth, verifyCoordinator } from '../src/screenAuth.ts';

const pair = () => generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const hospital = pair();
const stranger = pair();
const NOW = new Date('2030-01-01T08:00:00Z');
const seconds = Math.floor(NOW.getTime() / 1000);

const auth: ICoordinatorAuth = {
    acceptedAudiences: [ 'jitsi' ],
    acceptedIssuers: [ 'chat' ],
    // The hospital's key server: the public key by the key id.
    keyFor: async kid => kid === 'hospital/key' ? hospital.publicKey : undefined,
    marker: parseRoleMarker('user.hospital_role=coordinator', 'X') as never
};

/**
 * Signs a coordinator's token with the hospital's key unless told otherwise.
 *
 * @param {Object} over - What differs from a good token.
 * @returns {string}
 */
function token(over: { claims?: Record<string, unknown>; kid?: string; privateKey?: string; } = {}): string {
    return signToken({
        claims: {
            aud: 'jitsi',
            context: { user: { hospital_role: 'coordinator', id: 'coord-1', name: 'Coordinator C' } },
            exp: seconds + 3600,
            iss: 'chat',
            nbf: seconds - 60,
            sub: 'meet.jitsi',
            ...over.claims
        },
        kid: over.kid ?? 'hospital/key',
        privateKey: over.privateKey ?? hospital.privateKey
    });
}

describe('signing in to the coordinator screen', () => {
    it('accepts the hospital issuer\'s token that carries the coordinator role marker, and says who signed in', async () => {
        assert.deepEqual(await verifyCoordinator(token(), auth, NOW), { id: 'coord-1', name: 'Coordinator C' });
    });

    it('refuses a token without the coordinator role marker', async () => {
        const staff = token({ claims: { context: { user: { hospital_role: 'staff', id: 's-1' } } } });

        await assert.rejects(verifyCoordinator(staff, auth, NOW), /not_a_coordinator/u);
    });

    it('refuses a token signed with a key that is not the issuer\'s', async () => {
        await assert.rejects(verifyCoordinator(token({ privateKey: stranger.privateKey }), auth, NOW), /bad_signature/u);
    });

    it('refuses a token whose key id the issuer does not have', async () => {
        await assert.rejects(verifyCoordinator(token({ kid: 'unknown/key' }), auth, NOW), /unknown_key/u);
    });

    it('refuses another issuer and another audience', async () => {
        await assert.rejects(verifyCoordinator(token({ claims: { iss: 'someone' } }), auth, NOW), /wrong_issuer/u);
        await assert.rejects(verifyCoordinator(token({ claims: { aud: 'elsewhere' } }), auth, NOW), /wrong_audience/u);
    });

    it('refuses a token that has expired, or is not valid yet', async () => {
        await assert.rejects(verifyCoordinator(token({ claims: { exp: seconds - 1 } }), auth, NOW), /expired/u);
        await assert.rejects(verifyCoordinator(token({ claims: { nbf: seconds + 600 } }), auth, NOW), /not_yet_valid/u);
    });

    it('refuses what is not a token, and a token that is not signed', async () => {
        await assert.rejects(verifyCoordinator('nonsense', auth, NOW), /malformed/u);

        const unsigned = `${Buffer.from('{"alg":"none","kid":"hospital/key"}').toString('base64url')}.${
            Buffer.from(JSON.stringify({ aud: 'jitsi', context: { user: { hospital_role: 'coordinator', id: 'x' } }, iss: 'chat' })).toString('base64url')}.`;

        await assert.rejects(verifyCoordinator(unsigned, auth, NOW), /unsupported_algorithm/u);
    });

    it('needs the coordinator to have a verified id', async () => {
        const anonymous = token({ claims: { context: { user: { hospital_role: 'coordinator' } } } });

        await assert.rejects(verifyCoordinator(anonymous, auth, NOW), /no_identity/u);
    });
});

describe('the issuer\'s keys', () => {
    it('are named by the SHA-256 of the key id', () => {
        assert.equal(createHash('sha256').update('hospital/key').digest('hex').length, 64);
    });
});
