/**
 * The heartbeat this worker sends to the coordinator service (ADR 0014): every few seconds, with the worker's own
 * secret, through the web server's TLS. The coordinator service hands consultations only to the workers it heard from
 * lately, and takes a lost worker's consultations over (ADR 0016). A heartbeat that fails is only logged: the next one
 * is a few seconds away, and the worker keeps recording meanwhile.
 */
import { errorCode, log } from './log.ts';

/** How often a heartbeat is sent. The coordinator service takes a worker for lost after three missed ones. */
export const HEARTBEAT_MS = 5_000;

/** How long the coordinator service's word that this worker sweeps the storage root holds without a new one: three heartbeats. */
const SWEEPER_VALID_MS = 3 * HEARTBEAT_MS;

/** How long a heartbeat may take to be answered. */
const TIMEOUT_MS = 4_000;

export interface IHeartbeatOptions {

    /** The control API address the coordinator service reaches this worker at. */
    advertisedUrl: string;

    /** The build this worker runs, so that a deployment can see the new build come up (ADR 0017). */
    build: string;

    /** The coordinator service's base URL, as the web server proxies it, for example `https://meet.example/coordinator`. */
    coordinatorUrl: string;

    /** The worker's id on the coordinator service's list. */
    id: string;

    /** How often to send; for tests. */
    intervalMs?: number;

    /** The clock, in milliseconds; for tests. */
    now?: () => number;

    /** Called with the consultations the coordinator service took over, from the answer: this worker stops them. */
    onTakenOver?: (consultationIds: string[]) => void;

    /** The worker's own secret on that list: the same one the coordinator service sends with its requests. */
    secret: string;

    /** What this worker can run, and runs now, with the ids of the consultations it runs. */
    status: () => { capacity: number; consultations?: string[]; running: number; };
}

export class Heartbeat {
    private readonly _options: IHeartbeatOptions;
    private _sweeperUntil = 0;
    private _timer?: ReturnType<typeof setInterval>;

    /**
     * Creates the heartbeat. Call {@link start} to start sending.
     *
     * @param {IHeartbeatOptions} options - Options.
     */
    constructor(options: IHeartbeatOptions) {
        this._options = options;
    }

    /**
     * Whether the coordinator service named this worker, in its last answer, to be the one that sweeps the evidence
     * storage root. It stops holding when the answers stop coming, because the coordinator service then names another
     * worker, and two must not sweep at once.
     *
     * @returns {boolean}
     */
    get sweeper(): boolean {
        return (this._options.now ?? Date.now)() < this._sweeperUntil;
    }

    /**
     * Sends one heartbeat. It never rejects.
     *
     * @returns {Promise<boolean>} Whether the coordinator service accepted it.
     */
    async send(): Promise<boolean> {
        const { advertisedUrl, build, coordinatorUrl, id, secret, status } = this._options;

        try {
            const { capacity, consultations, running } = status();
            const response = await fetch(`${coordinatorUrl.replace(/\/+$/u, '')}/workers/heartbeat`, {
                body: JSON.stringify({ build, capacity, consultations, id, kind: 'recorder-bot', running, url: advertisedUrl }),
                headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' },
                method: 'POST',
                signal: AbortSignal.timeout(TIMEOUT_MS)
            });

            if (!response.ok) {
                log.warn('the coordinator service refused the heartbeat', { status: response.status });
            } else {
                const reply = await response.json().catch(() => ({})) as { sweeper?: unknown; takenOver?: unknown; };

                this._sweeperUntil = reply?.sweeper === true ? (this._options.now ?? Date.now)() + SWEEPER_VALID_MS : 0;

                this._stopTakenOver(reply.takenOver);
            }

            return response.ok;
        } catch (error) {
            log.warn('could not send a heartbeat', { error: errorCode(error) });

            return false;
        }
    }

    /**
     * Reads the consultations the answer says were taken over, when this worker was cut off from the coordinator
     * service for a while, and hands them to the worker to stop (ADR 0016).
     *
     * @param {unknown} takenOver - What the answer says: the ids of the consultations.
     * @returns {void}
     */
    private _stopTakenOver(takenOver: unknown): void {
        const { onTakenOver } = this._options;

        if (!onTakenOver) {
            return;
        }

        if (Array.isArray(takenOver) && takenOver.length) {
            onTakenOver(takenOver.filter((id): id is string => typeof id === 'string'));
        }
    }

    /**
     * Sends a heartbeat now, then one at every interval.
     *
     * @returns {void}
     */
    start(): void {
        this.send();
        this._timer = setInterval(() => this.send(), this._options.intervalMs ?? HEARTBEAT_MS);
        this._timer.unref();
    }

    /**
     * Stops sending.
     *
     * @returns {void}
     */
    stop(): void {
        clearInterval(this._timer);
    }
}
