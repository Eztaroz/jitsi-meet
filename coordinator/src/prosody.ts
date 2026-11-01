/**
 * The client of the coordinator API of Prosody (`resources/prosody-plugins/mod_coordinator_api.lua`).
 */
import { signToken } from './jwt.ts';

export class ProsodyUnavailableError extends Error {
    readonly code: string;

    /**
     * Prosody could not be asked.
     *
     * @param {string} code - Why: `unreachable` or `rejected`. Never contains an HN.
     */
    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

export class Prosody {
    private readonly _kid: string;
    private readonly _privateKey: string;
    private readonly _url: string;

    /**
     * Creates the client.
     *
     * @param {Object} options - Options.
     * @param {string} options.kid - The coordinator service's key id.
     * @param {string} options.privateKey - Its PEM private key.
     * @param {string} options.url - Prosody's HTTP base URL, e.g. http://prosody:5280.
     */
    constructor({ kid, privateKey, url }: { kid: string; privateKey: string; url: string; }) {
        this._kid = kid;
        this._privateKey = privateKey;
        this._url = url;
    }

    /**
     * Returns the rooms that are open and their occupants, as Prosody reports them.
     *
     * @returns {Promise<unknown>}
     */
    async rooms(): Promise<unknown> {
        const now = Math.floor(Date.now() / 1000);
        const token = signToken({
            claims: { aud: 'coordinator', exp: now + 60, iss: 'coordinator', nbf: now - 10, sub: 'coordinator' },
            kid: this._kid,
            privateKey: this._privateKey
        });
        let response: Response;

        try {
            response = await fetch(`${this._url}/coordinator/rooms`, {
                headers: { authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000)
            });
        } catch {
            throw new ProsodyUnavailableError('unreachable');
        }
        if (!response.ok) {
            throw new ProsodyUnavailableError('rejected');
        }

        return response.json();
    }
}
