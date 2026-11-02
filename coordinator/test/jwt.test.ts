import assert from 'node:assert/strict';
import { createVerify, generateKeyPairSync } from 'node:crypto';
import { describe, it } from 'node:test';

import { signToken } from '../src/jwt.ts';

describe('signing a token', () => {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
        modulusLength: 2048,
        privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
        publicKeyEncoding: { format: 'pem', type: 'spki' }
    });

    it('produces an RS256 token a verifier with the public key accepts, carrying the key id and claims', () => {
        const token = signToken({ claims: { aud: 'coordinator', iss: 'coordinator', sub: 'coordinator' }, kid: 'k/1', privateKey });
        const [ header, payload, signature ] = token.split('.');

        assert.deepEqual(JSON.parse(Buffer.from(header, 'base64url').toString()), { alg: 'RS256', kid: 'k/1', typ: 'JWT' });
        assert.equal(JSON.parse(Buffer.from(payload, 'base64url').toString()).aud, 'coordinator');
        assert.ok(createVerify('RSA-SHA256').update(`${header}.${payload}`).verify(publicKey, signature, 'base64url'));
    });

    it('is not accepted for different claims', () => {
        const [ header, , signature ] = signToken({ claims: { sub: 'a' }, kid: 'k', privateKey }).split('.');
        const forged = Buffer.from(JSON.stringify({ sub: 'b' })).toString('base64url');

        assert.ok(!createVerify('RSA-SHA256').update(`${header}.${forged}`).verify(publicKey, signature, 'base64url'));
    });
});
