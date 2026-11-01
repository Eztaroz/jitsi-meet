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
        return (await this._call('/coordinator/rooms')).json();
    }

    /**
     * Sends a participant the command to move. Prosody sends it from the room's own address.
     *
     * @param {Object} options - Options.
     * @param {string} options.endpointId - The participant's endpoint id.
     * @param {Record<string, unknown>} options.move - What the participant's client receives.
     * @param {string} options.room - The room they are in, as Prosody names it.
     * @returns {Promise<void>}
     */
    async sendMove({ endpointId, move, room }: {
        endpointId: string;
        move: Record<string, unknown>;
        room: string;
    }): Promise<void> {
        await this._call('/coordinator/moves', {
            body: JSON.stringify({ endpointId, move, room }),
            headers: { 'content-type': 'application/json' },
            method: 'POST'
        });
    }

    /**
     * Calls Prosody's coordinator API with a system token.
     *
     * @param {string} route - The path.
     * @param {RequestInit} init - Request options.
     * @returns {Promise<Response>}
     */
    private async _call(route: string, init: RequestInit = {}): Promise<Response> {
        const now = Math.floor(Date.now() / 1000);
        const token = signToken({
            claims: { aud: 'coordinator', exp: now + 60, iss: 'coordinator', nbf: now - 10, sub: 'coordinator' },
            kid: this._kid,
            privateKey: this._privateKey
        });
        let response: Response;

        try {
            response = await fetch(`${this._url}${route}`, {
                ...init,
                headers: { ...init.headers as Record<string, string>, authorization: `Bearer ${token}` },
                signal: AbortSignal.timeout(10_000)
            });
        } catch {
            throw new ProsodyUnavailableError('unreachable');
        }
        if (!response.ok) {
            throw new ProsodyUnavailableError(response.status === 404 ? 'not_found' : 'rejected');
        }

        return response;
    }
}
