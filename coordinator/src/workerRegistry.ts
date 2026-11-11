/**
 * The workers the coordinator service has heard from (ADR 0014). A worker sends a heartbeat every few seconds with
 * its own secret; the service keeps what each one said, and a worker not heard from for `LOST_AFTER_MS` is lost. The
 * list of ids and secrets is a file that is read again whenever it changes, so that a line added brings a worker into
 * service, and a line removed shuts it out at once.
 *
 * Nothing here is stored: after a restart the registry is whole again within one heartbeat period.
 */
import { createHash, timingSafeEqual } from 'node:crypto';
import { statSync } from 'node:fs';

import { type IWorkerSecret, loadWorkerSecrets } from './config.ts';
import { HttpError } from './http.ts';
import { log } from './log.ts';
import { RecorderBot } from './recorderBot.ts';
import { VideoPlayer } from './videoPlayer.ts';
import type { IRecorderBotWorker, IVideoPlayerWorker } from './workers.ts';

/** How often a worker sends a heartbeat, for the workers' own settings and the documentation. */
export const HEARTBEAT_MS = 5_000;

/** How long a worker may be silent before it is lost: three heartbeats. */
export const LOST_AFTER_MS = 15_000;

/** The kinds of worker, as a heartbeat names them. */
export type WorkerKind = 'recorder-bot' | 'video-player';

/** What the API lists about a worker. */
export interface IWorkerStatus {
    build: string;
    capacity: number;
    draining: boolean;
    id: string;
    kind: WorkerKind;
    lost: boolean;
    running: number;
    url: string;
}

/** What the answer to a heartbeat tells the worker. */
export interface IHeartbeatReply {

    /** Whether the pipeline set the worker draining: it finishes what it runs and gets nothing new (ADR 0014). */
    draining: boolean;

    /** Set for a recorder bot: whether it is the one that sweeps the evidence storage root (ADR 0014). */
    sweeper?: boolean;
}

interface IHeard {
    build: string;
    capacity: number;
    kind: WorkerKind;
    lastSeen: number;
    running: number;
    url: string;
}

const MAX_BUILD_LENGTH = 100;

/**
 * Compares two secrets in constant time.
 *
 * @param {string} a - One secret.
 * @param {string} b - The other.
 * @returns {boolean}
 */
function sameSecret(a: string, b: string): boolean {
    const digest = (s: string) => createHash('sha256').update(s).digest();

    return timingSafeEqual(digest(a), digest(b));
}

export class WorkerRegistry {
    private readonly _clients = new Map<string, IRecorderBotWorker | IVideoPlayerWorker>();
    private readonly _draining = new Set<string>();
    private readonly _file: string;
    private readonly _heard = new Map<string, IHeard>();
    private _list: { recorderBots: IWorkerSecret[]; videoPlayers: IWorkerSecret[]; };
    private _listVersion = '';
    private _sweeper?: string;
    private readonly _now: () => number;
    private readonly _playTimeoutMs?: number;

    /**
     * Creates the registry, and reads the list of workers.
     *
     * @param {Object} options - Options.
     * @param {string} options.file - The list of workers and their secrets.
     * @param {Function} [options.now] - The clock, in milliseconds.
     * @param {number} [options.playTimeoutMs] - How long a video player may take to answer `/play`.
     * @throws {Error} When the list cannot be read.
     */
    constructor({ file, now = Date.now, playTimeoutMs }: { file: string; now?: () => number; playTimeoutMs?: number; }) {
        this._file = file;
        this._now = now;
        this._playTimeoutMs = playTimeoutMs;
        this._list = this._read();
    }

    /**
     * Reads the list of workers again when the file changed. A file that cannot be read now keeps the last good list,
     * and says so: a typo while editing must not shut every worker out.
     *
     * @returns {{ recorderBots: IWorkerSecret[]; videoPlayers: IWorkerSecret[]; }}
     */
    private _read(): { recorderBots: IWorkerSecret[]; videoPlayers: IWorkerSecret[]; } {
        const stat = statSync(this._file);
        const version = `${stat.mtimeMs}:${stat.size}`;

        if (version !== this._listVersion || !this._list) {
            this._list = loadWorkerSecrets(this._file);
            this._listVersion = version;
        }

        return this._list;
    }

    /**
     * The list now.
     *
     * @returns {{ recorderBots: IWorkerSecret[]; videoPlayers: IWorkerSecret[]; }}
     */
    private _current(): { recorderBots: IWorkerSecret[]; videoPlayers: IWorkerSecret[]; } {
        try {
            return this._read();
        } catch (error) {
            log.warn('cannot read the list of workers, keeping the last one', { reason: (error as Error).message });

            return this._list;
        }
    }

    /**
     * Notes a heartbeat.
     *
     * @param {string|undefined} secret - The bearer secret it came with.
     * @param {unknown} body - Its JSON: id, kind, url, capacity, running and build.
     * @throws {HttpError} 401 when the secret is not the one of a worker on the list, 400 when the heartbeat is
     * malformed or names another kind than the list does.
     * @returns {IHeartbeatReply} What to tell the worker.
     */
    heartbeat(secret: string | undefined, body: unknown): IHeartbeatReply {
        const given = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
        const list = this._current();
        const kind: WorkerKind | undefined = list.recorderBots.some(w => w.id === given.id) ? 'recorder-bot'
            : list.videoPlayers.some(w => w.id === given.id) ? 'video-player' : undefined;
        const entry = [ ...list.recorderBots, ...list.videoPlayers ].find(w => w.id === given.id);

        if (!secret || !entry || !sameSecret(secret, entry.secret)) {
            log.warn('refused a heartbeat', { worker: typeof given.id === 'string' ? given.id.slice(0, 100) : undefined });
            throw new HttpError(401, 'unknown worker or wrong secret');
        }
        if (given.kind !== kind) {
            throw new HttpError(400, `kind must be "${kind}" for the worker "${entry.id}"`);
        }

        const count = (name: string): number => {
            const value = given[name];

            if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
                throw new HttpError(400, `${name} must be a non-negative integer`);
            }

            return value;
        };
        const capacity = count('capacity');
        const running = count('running');

        if (typeof given.build !== 'string' || !given.build.trim() || given.build.length > MAX_BUILD_LENGTH) {
            throw new HttpError(400, `build must be a text of 1 to ${MAX_BUILD_LENGTH} characters`);
        }

        let url: URL;

        try {
            url = new URL(String(given.url));
        } catch {
            throw new HttpError(400, 'url must be the control API address');
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
            throw new HttpError(400, 'url must be the control API address');
        }

        this._heard.set(entry.id, {
            build: given.build, capacity, kind: kind!, lastSeen: this._now(), running, url: url.href.replace(/\/+$/u, '')
        });

        const draining = this._draining.has(entry.id);

        return kind === 'recorder-bot' ? { draining, sweeper: this._elect(entry.id, list.recorderBots) } : { draining };
    }

    /**
     * Sets a worker draining, or taking work again. It is kept in memory like the rest of the registry, and holds
     * for a worker not heard from yet; a worker taken off the list is forgotten with its line.
     *
     * @param {string} id - The worker's id.
     * @param {boolean} draining - Whether it is draining.
     * @throws {HttpError} 404 when the worker is not on the list.
     * @returns {void}
     */
    setDraining(id: string, draining: boolean): void {
        const { recorderBots, videoPlayers } = this._current();

        if (![ ...recorderBots, ...videoPlayers ].some(w => w.id === id)) {
            throw new HttpError(404, `no worker "${id}" on the list`);
        }
        if (draining) {
            this._draining.add(id);
        } else {
            this._draining.delete(id);
        }
    }

    /**
     * Whether a recorder bot that just sent a heartbeat is the one that sweeps the evidence storage root. The one
     * named keeps it while it is heard from lately and on the list; when it is not, the next recorder bot to send a
     * heartbeat takes over, so that exactly one sweeps at a time. The one named first does not get it back when it
     * returns after another took over.
     *
     * @param {string} id - The recorder bot.
     * @param {IWorkerSecret[]} recorderBots - The recorder bots on the list.
     * @returns {boolean}
     */
    private _elect(id: string, recorderBots: IWorkerSecret[]): boolean {
        const current = this._sweeper === undefined ? undefined : this._heard.get(this._sweeper);
        const holds = current !== undefined && recorderBots.some(w => w.id === this._sweeper)
            && (this._sweeper === id || this._now() - current.lastSeen < LOST_AFTER_MS);

        if (!holds) {
            this._sweeper = id;
        }

        return this._sweeper === id;
    }

    /**
     * The workers heard from that are still on the list, lost ones included.
     *
     * @returns {IWorkerStatus[]}
     */
    list(): IWorkerStatus[] {
        const now = this._now();
        const { recorderBots, videoPlayers } = this._current();
        const listed = new Set([ ...recorderBots, ...videoPlayers ].map(w => w.id));

        // A worker whose line was removed is forgotten, so that putting it back starts from its next heartbeat.
        for (const id of [ ...this._heard.keys(), ...this._draining ]) {
            if (!listed.has(id)) {
                this._heard.delete(id);
                this._draining.delete(id);
            }
        }

        return [ ...this._heard ].map(([ id, h ]) => ({
            build: h.build, capacity: h.capacity, draining: this._draining.has(id), id, kind: h.kind, lost: now - h.lastSeen >= LOST_AFTER_MS,
            running: h.running, url: h.url
        })).sort((a, b) => a.id.localeCompare(b.id));
    }

    /**
     * The recorder bots to hand consultations to: heard from lately and on the list.
     *
     * @returns {IRecorderBotWorker[]}
     */
    recorderBots(): IRecorderBotWorker[] {
        return this._live('recorder-bot', (id, url, secret) => new RecorderBot(url, secret, id));
    }

    /**
     * The recorder bots that were heard from and have fallen silent, with the time of their last heartbeat: the ones
     * whose consultations are taken over (ADR 0016).
     *
     * @returns {{ id: string; lastSeen: Date; }[]}
     */
    lostRecorderBots(): { id: string; lastSeen: Date; }[] {
        const lost = new Set(this.list().filter(w => w.lost && w.kind === 'recorder-bot').map(w => w.id));

        return [ ...this._heard ].filter(([ id ]) => lost.has(id)).map(([ id, h ]) => ({ id, lastSeen: new Date(h.lastSeen) }));
    }

    /**
     * The video players to hand waiting videos to: heard from lately and on the list.
     *
     * @returns {IVideoPlayerWorker[]}
     */
    videoPlayers(): IVideoPlayerWorker[] {
        return this._live('video-player', (id, url, secret) =>
            new VideoPlayer(url, secret, { id, playTimeoutMs: this._playTimeoutMs }));
    }

    /**
     * The clients of the workers of a kind that are not lost. A client lives as long as the worker's address and
     * secret stay the same, so that what the pool remembers of it (skipped lately) stays.
     *
     * @param {WorkerKind} kind - The kind.
     * @param {Function} make - Makes a client from an id, an address and a secret.
     * @returns {T[]}
     */
    private _live<T extends IRecorderBotWorker | IVideoPlayerWorker>(kind: WorkerKind,
            make: (id: string, url: string, secret: string) => T): T[] {
        const status = new Map(this.list().filter(w => !w.lost && w.kind === kind).map(w => [ w.id, w ]));
        const { recorderBots, videoPlayers } = this._current();
        const secrets = kind === 'recorder-bot' ? recorderBots : videoPlayers;
        const clients: T[] = [];

        for (const { id, secret } of secrets) {
            const heard = status.get(id);

            if (!heard) {
                continue;
            }

            const key = `${kind}|${id}|${heard.url}|${createHash('sha256').update(secret).digest('hex')}`;

            if (!this._clients.has(key)) {
                this._clients.set(key, make(id, heard.url, secret));
            }

            const client = this._clients.get(key) as T;

            // Set on each look: a draining worker stays a worker, to stop what it runs, but is handed nothing new.
            client.draining = this._draining.has(id);
            clients.push(client);
        }

        return clients;
    }
}
