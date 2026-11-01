/**
 * The client of the recorder bot service's control API.
 */

export class RecorderBotUnavailableError extends Error {
    readonly code: string;

    /**
     * The recorder bot could not be asked to record a room.
     *
     * @param {string} code - Why: `at_capacity`, `unreachable` or `rejected`. Never contains an HN.
     */
    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

export class RecorderBot {
    private readonly _secret: string;
    private readonly _url: string;

    /**
     * Creates the client.
     *
     * @param {string} url - The recorder bot service's base URL.
     * @param {string} secret - Its bearer secret.
     */
    constructor(url: string, secret: string) {
        this._url = url;
        this._secret = secret;
    }

    /**
     * Asks the recorder bot to record a patient's room.
     *
     * @param {string} hn - The patient's HN.
     * @returns {Promise<void>}
     */
    async recordRoom(hn: string): Promise<void> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/consultations`, {
                body: JSON.stringify({ hn }),
                headers: { authorization: `Bearer ${this._secret}`, 'content-type': 'application/json' },
                method: 'POST',
                signal: AbortSignal.timeout(10_000)
            });
        } catch {
            throw new RecorderBotUnavailableError('unreachable');
        }

        if (response.status === 503) {
            throw new RecorderBotUnavailableError('at_capacity');
        }
        if (!response.ok) {
            throw new RecorderBotUnavailableError('rejected');
        }
    }
}
