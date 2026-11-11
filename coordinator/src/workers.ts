/**
 * The workers (recorder bots and video players) the coordinator service hands work to: each new consultation, or
 * waiting video, goes to the worker of its kind with the most room, and a worker that is full or silent is skipped
 * (ADR 0014). They are a fixed list, or the workers the heartbeats tell of (`workerRegistry.ts`).
 */
import { RecorderBotUnavailableError } from './recorderBot.ts';
import { type IVideoPlayer, VideoPlayerUnavailableError } from './videoPlayer.ts';

/** How long a worker that did not answer, or was full, is tried last. */
export const SKIP_MS = 10_000;

/** A worker as the pool sees it. */
export interface IWorker {

    /** Set draining by the pipeline: it finishes what it runs, and gets no new work (ADR 0014). */
    draining?: boolean;

    /** Names the worker in what the coordinator service keeps. */
    id: string;

    /** How many more it can take now: its capacity minus what it runs. Rejects when it does not answer. */
    room: () => Promise<number>;
}

/** A recorder bot worker. */
export interface IRecorderBotWorker extends IWorker {
    recordRoom: (hn: string, consultationId: string) => Promise<string>;
}

/** A video player worker. */
export interface IVideoPlayerWorker extends IWorker, IVideoPlayer {}

/**
 * Tries the workers that have room, the one with the most first, until one takes the work.
 */
class Pool<T extends IWorker> {
    private readonly _skipped = new Map<string, number>();
    private readonly _source: T[] | (() => T[]);

    /**
     * Creates the pool.
     *
     * @param {T[]|Function} workers - The workers, in the order of the configuration; or a function that gives the
     * workers there are now, as the heartbeats tell.
     */
    constructor(workers: T[] | (() => T[])) {
        this._source = workers;
    }

    /**
     * The workers to hand work to now.
     *
     * @returns {T[]}
     */
    protected get _workers(): T[] {
        return typeof this._source === 'function' ? this._source() : this._source;
    }

    /**
     * Offers a piece of work to the workers with room, most room first; a worker that is full, does not answer or
     * fails is skipped for the next one, and for the next requests for a while.
     *
     * @param {Function} offer - Gives the work to one worker; it throws the unavailable error of its kind.
     * @param {Function} isUnavailable - Whether an error means the worker cannot take the work, rather than the work
     * being wrong.
     * @param {Function} makeError - Makes the unavailable error of the kind, with a code.
     * @returns {Promise<{ result: R; worker: T; }>}
     */
    protected async _assign<R>(offer: (worker: T) => Promise<R>, isUnavailable: (error: unknown) => boolean,
            makeError: (code: string) => Error): Promise<{ result: R; worker: T; }> {
        const now = Date.now();
        const workers = this._workers.filter(w => !w.draining);
        const rooms = await Promise.all(workers.map(w => w.room().catch(() => undefined)));
        const skipped = (id: string) => (this._skipped.get(id) ?? 0) > now;

        for (const [ index, room ] of rooms.entries()) {
            if (room === undefined) {
                this._skipped.set(workers[index].id, now + SKIP_MS);
            }
        }

        // Workers that answered with room first, most room first; then the ones silent just now or skipped lately.
        const late = (w: { room?: number; worker: T; }) => Number(w.room === undefined || skipped(w.worker.id));
        const order = workers
            .map((worker, index) => ({ index, room: rooms[index], worker }))
            .filter(w => w.room === undefined || w.room > 0)
            .sort((a, b) => late(a) - late(b) || (b.room ?? 0) - (a.room ?? 0) || a.index - b.index);
        let failed = rooms.some(r => r === undefined);

        for (const { worker } of order) {
            try {
                return { result: await offer(worker), worker };
            } catch (error) {
                if (!isUnavailable(error)) {
                    throw error;
                }
                failed = true;
                this._skipped.set(worker.id, Date.now() + SKIP_MS);
            }
        }

        // At capacity only when every worker answered and none has room.
        throw makeError(failed ? 'unreachable' : 'at_capacity');
    }
}

/** Hands consultations to a list of recorder bots, and remembers which one records each. */
export class RecorderBotPool extends Pool<IRecorderBotWorker> {
    private readonly _recording = new Map<string, string>();

    /**
     * Hands a consultation to the recorder bot with the most room.
     *
     * @param {string} hn - The patient's HN.
     * @param {string} consultationId - The consultation's id.
     * @returns {Promise<string>} The id of the consultation recording the room.
     */
    async recordRoom(hn: string, consultationId: string): Promise<string> {
        const { result, worker } = await this._assign(w => w.recordRoom(hn, consultationId),
            error => error instanceof RecorderBotUnavailableError, code => new RecorderBotUnavailableError(code));

        this._recording.set(result, worker.id);

        return result;
    }

    /**
     * Which recorder bot records a consultation.
     *
     * @param {string} consultationId - The consultation.
     * @returns {string|undefined}
     */
    workerOf(consultationId: string): string | undefined {
        return this._recording.get(consultationId);
    }
}

/** Hands waiting videos to a list of video players, and remembers which one plays in which room. */
export class VideoPlayerPool extends Pool<IVideoPlayerWorker> implements IVideoPlayer {
    private readonly _playing = new Map<string, string>();

    /**
     * Hands a video to the video player with the most room.
     *
     * @param {Object} request - The room, a token for it and the video's URL.
     * @returns {Promise<void>}
     */
    async play(request: { room: string; token: string; videoUrl: string; }): Promise<void> {
        const { worker } = await this._assign(w => w.play(request),
            error => error instanceof VideoPlayerUnavailableError && error.code !== 'already_playing',
            code => new VideoPlayerUnavailableError(code));

        this._playing.set(request.room, worker.id);
    }

    /**
     * The rooms a video is playing in, on every video player. A video player that does not answer keeps the rooms it
     * was known to play in; the rooms of the ones that do are learnt again, so the list is whole after a restart. A
     * video player that is no longer a worker (lost, or taken off the list) plays nothing the service can stop: its
     * rooms are forgotten.
     *
     * @returns {Promise<string[]>}
     */
    async playingRooms(): Promise<string[]> {
        const workers = this._workers;
        const answers = await Promise.all(workers.map(
            w => w.playingRooms().then(rooms => ({ rooms, worker: w }), () => ({ rooms: undefined, worker: w }))));
        const answered = new Set(answers.filter(a => a.rooms).map(a => a.worker.id));

        for (const [ room, id ] of [ ...this._playing ]) {
            if (answered.has(id) || !workers.some(w => w.id === id)) {
                this._playing.delete(room);
            }
        }
        for (const { rooms, worker } of answers) {
            for (const room of rooms ?? []) {
                this._playing.set(room, worker.id);
            }
        }

        return [ ...this._playing.keys() ];
    }

    /**
     * Stops the video of a room on the video player that plays it; when none is known to, on all of them.
     *
     * @param {string} room - The room.
     * @returns {Promise<void>}
     */
    async stop(room: string): Promise<void> {
        const id = this._playing.get(room);
        const workers = id === undefined ? this._workers : this._workers.filter(w => w.id === id);

        this._playing.delete(room);

        const results = await Promise.allSettled(workers.map(w => w.stop(room)));
        const failed = results.find(r => r.status === 'rejected');

        if (failed) {
            throw failed.reason;
        }
    }

    /**
     * Which video player plays in a room.
     *
     * @param {string} room - The room.
     * @returns {string|undefined}
     */
    workerOf(room: string): string | undefined {
        return this._playing.get(room);
    }
}
