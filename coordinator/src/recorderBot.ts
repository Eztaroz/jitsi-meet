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

/** What the coordinator service needs from the recorder bots; tests fake it. */
export interface IRecorderBot {

    /** Records a patient's room as the consultation with that id; resolves to the id of the one recording the room. */
    recordRoom: (hn: string, consultationId: string) => Promise<string>;

    /** Names the recorder bot recording a consultation. */
    workerOf?: (consultationId: string) => string | undefined;

    /** Names the recorder bot when there is only one. */
    workerId?: string;
}

export class RecorderBot {

    /** Names this recorder bot in what the coordinator service keeps. */
    readonly id: string;
    private readonly _secret: string;
    private readonly _url: string;

    /**
     * Creates the client.
     *
     * @param {string} url - The recorder bot service's base URL.
     * @param {string} secret - Its bearer secret.
     * @param {string} [id] - The worker's id.
     */
    constructor(url: string, secret: string, id = 'recorder-bot') {
        this.id = id;
        this._url = url;
        this._secret = secret;
    }

    /**
     * How many more consultations the recorder bot can take: its capacity minus the ones it records.
     *
     * @returns {Promise<number>}
     */
    async room(): Promise<number> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/health`, {
                headers: { authorization: `Bearer ${this._secret}` },
                signal: AbortSignal.timeout(3_000)
            });
        } catch {
            throw new RecorderBotUnavailableError('unreachable');
        }
        if (!response.ok) {
            throw new RecorderBotUnavailableError('rejected');
        }

        const { activeConsultations, maxConsultations } = await response.json() as
            { activeConsultations?: number; maxConsultations?: number; };

        return Number(maxConsultations) - Number(activeConsultations);
    }

    /**
     * Asks the recorder bot to record a patient's room as a consultation with an id the coordinator service made.
     *
     * @param {string} hn - The patient's HN.
     * @param {string} consultationId - The consultation's id.
     * @returns {Promise<string>} The id of the consultation recording the room: the one given, or the one already
     * running in that room.
     */
    async recordRoom(hn: string, consultationId: string): Promise<string> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/consultations`, {
                body: JSON.stringify({ consultationId, hn }),
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

        return (await response.json() as { consultationId: string; }).consultationId;
    }
}
