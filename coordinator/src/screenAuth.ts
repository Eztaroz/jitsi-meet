/**
 * Signing in to the coordinator screen: the coordinator presents a token from the hospital's issuer, the same issuer
 * as the participants', that carries the coordinator role marker. The shared bearer secret is not accepted here: it is
 * the hospital's system's, and the audit log must say who a coordinator is.
 */
import { createHash, createVerify } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IRoleMarker } from './rooms.ts';

export class SignInError extends Error {
    readonly code: string;

    /**
     * A token that does not sign anyone in.
     *
     * @param {string} code - Why: a short code, safe to show and to log.
     */
    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

/** What a token has to be, to sign a coordinator in. */
export interface ICoordinatorAuth {
    acceptedAudiences: string[];
    acceptedIssuers: string[];

    /** Looks up the issuer's public key by the token's key id. */
    keyFor: (kid: string) => Promise<string | undefined>;

    /** Which claim and value mark a coordinator. */
    marker: IRoleMarker;
}

/** Who signed in. */
export interface ICoordinator {
    id: string;
    name?: string;
}

/**
 * Looks up the issuer's public keys in a directory, or on a key server, by the SHA-256 of the key id: the layout of
 * the ASAP key servers the deployment's participants' tokens use.
 *
 * @param {string} source - A directory, or the URL of a key server.
 * @returns {Function}
 */
export function keyLookup(source: string): ICoordinatorAuth['keyFor'] {
    const cache = new Map<string, string>();

    return async kid => {
        const cached = cache.get(kid);

        if (cached) {
            return cached;
        }

        const file = `${createHash('sha256').update(kid).digest('hex')}.pem`;
        let pem: string | undefined;

        try {
            pem = /^https?:\/\//u.test(source)
                ? await (async () => {
                    const response = await fetch(`${source.replace(/\/+$/u, '')}/${file}`, { signal: AbortSignal.timeout(10_000) });

                    return response.ok ? response.text() : undefined;
                })()
                : await readFile(join(source, file), 'utf8');
        } catch {
            pem = undefined;
        }
        if (pem) {
            cache.set(kid, pem);
        }

        return pem;
    };
}

/**
 * Decodes a part of a token.
 *
 * @param {string} part - The base64url text.
 * @returns {any}
 */
function decode(part: string): any {
    try {
        return JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
    } catch {
        throw new SignInError('malformed');
    }
}

/**
 * Checks a token and says who a coordinator is.
 *
 * @param {string} token - The token.
 * @param {ICoordinatorAuth} auth - What it has to be.
 * @param {Date} now - When.
 * @returns {Promise<ICoordinator>}
 * @throws {SignInError} When the token does not sign a coordinator in.
 */
export async function verifyCoordinator(token: string, auth: ICoordinatorAuth, now = new Date()): Promise<ICoordinator> {
    const parts = token.split('.');

    if (parts.length !== 3) {
        throw new SignInError('malformed');
    }

    const header = decode(parts[0]);
    const claims = decode(parts[1]);

    if (header?.alg !== 'RS256') {
        throw new SignInError('unsupported_algorithm');
    }
    if (typeof header.kid !== 'string') {
        throw new SignInError('unknown_key');
    }

    const key = await auth.keyFor(header.kid);

    if (!key) {
        throw new SignInError('unknown_key');
    }
    if (!createVerify('RSA-SHA256').update(`${parts[0]}.${parts[1]}`).verify(key, parts[2], 'base64url')) {
        throw new SignInError('bad_signature');
    }

    const seconds = now.getTime() / 1000;
    const audiences = [ claims.aud ].flat();

    if (!auth.acceptedIssuers.includes(claims.iss)) {
        throw new SignInError('wrong_issuer');
    }
    if (!audiences.some(a => auth.acceptedAudiences.includes(a))) {
        throw new SignInError('wrong_audience');
    }
    if (typeof claims.exp === 'number' && claims.exp <= seconds) {
        throw new SignInError('expired');
    }
    if (typeof claims.nbf === 'number' && claims.nbf > seconds) {
        throw new SignInError('not_yet_valid');
    }

    const user = claims.context?.user ?? {};
    const value = auth.marker.path[0] === 'group' ? claims.context?.group : user[auth.marker.path[1]];

    if (value !== auth.marker.value) {
        throw new SignInError('not_a_coordinator');
    }
    if (typeof user.id !== 'string' || !user.id) {
        throw new SignInError('no_identity');
    }

    return { id: user.id, name: typeof user.name === 'string' ? user.name : undefined };
}
