/**
 * The client of the recorder bot service's control API.
 */
import type { IStationConsultation } from './rules.ts';

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
     * @param {IStationConsultation} station - Set to record one patient's time in a station instead (ADR 0006).
     * @returns {Promise<string>} The consultation's id.
     */
    async recordRoom(hn: string, station?: IStationConsultation): Promise<string> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/consultations`, {
                body: JSON.stringify(station ? { hn, patient: station.patientId, room: station.room } : { hn }),
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

    /**
     * Stops a consultation before its time. A station's consultation whose patient never arrived is discarded.
     *
     * @param {string} consultationId - The consultation.
     * @returns {Promise<void>}
     */
    async stop(consultationId: string): Promise<void> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/consultations/${consultationId}/stop`, {
                headers: { authorization: `Bearer ${this._secret}` },
                method: 'POST',
                signal: AbortSignal.timeout(60_000)
            });
        } catch {
            throw new RecorderBotUnavailableError('unreachable');
        }
        if (!response.ok) {
            throw new RecorderBotUnavailableError('rejected');
        }
    }

    /**
     * Reads a consultation's status.
     *
     * @param {string} consultationId - The consultation.
     * @returns {Promise<string>} Its status, such as `waiting_for_participants`.
     */
    async status(consultationId: string): Promise<string> {
        let response: Response;

        try {
            response = await fetch(`${this._url}/consultations/${consultationId}`, {
                headers: { authorization: `Bearer ${this._secret}` },
                signal: AbortSignal.timeout(10_000)
            });
        } catch {
            throw new RecorderBotUnavailableError('unreachable');
        }
        if (!response.ok) {
            throw new RecorderBotUnavailableError('rejected');
        }

        return (await response.json() as { status: string; }).status;
    }
}
