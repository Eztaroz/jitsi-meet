/**
 * Signs the coordinator service's tokens: RS256 JWTs that Prosody verifies with the service's public key, which it
 * fetches by the SHA-256 of the key id (ASAP).
 */
import { createSign } from 'node:crypto';

/**
 * Encodes text or bytes as base64url.
 *
 * @param {string|Buffer} data - The data.
 * @returns {string}
 */
function base64url(data: string | Buffer): string {
    return Buffer.from(data).toString('base64url');
}

/**
 * Signs a token.
 *
 * @param {Object} options - Options.
 * @param {Record<string, unknown>} options.claims - The claims, such as iss, aud, sub and exp.
 * @param {string} options.kid - The key id.
 * @param {string} options.privateKey - The PEM private key.
 * @returns {string}
 */
export function signToken({ claims, kid, privateKey }: {
    claims: Record<string, unknown>;
    kid: string;
    privateKey: string;
}): string {
    const signingInput = `${base64url(JSON.stringify({ alg: 'RS256', kid, typ: 'JWT' }))}.${
        base64url(JSON.stringify(claims))}`;
    const signature = createSign('RSA-SHA256').update(signingInput).sign(privateKey);

    return `${signingInput}.${base64url(signature)}`;
}
