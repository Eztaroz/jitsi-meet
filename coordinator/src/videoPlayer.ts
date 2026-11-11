/**
 * The client of the video player service's control API (`video-player/deploy/README.md`). The service has no callback
 * for the end of a video: a room that is no longer in its `/health` list has finished.
 */
export class VideoPlayerUnavailableError extends Error {
    readonly code: string;

    /**
     * The video player could not be asked to play or stop a video.
     *
     * @param {string} code - Why: `at_capacity`, `already_playing`, `unreachable` or `rejected`.
     */
    constructor(code: string) {
        super(code);
        this.code = code;
    }
}

/** What the coordinator service needs from the video player; tests fake it. */
export interface IVideoPlayer {

    /** Plays a video once in a room, as a participant that joins with the token. */
    play: (request: { room: string; token: string; videoUrl: string; }) => Promise<void>;

    /** The rooms a video is playing in now. */
    playingRooms: () => Promise<string[]>;

    /** Stops the video of a room; nothing to stop is not an error. */
    stop: (room: string) => Promise<void>;
}

/** How long `/play` may take: the service starts a Chromium before it answers, and a cold start is slow. */
export const DEFAULT_PLAY_TIMEOUT_MS = 45_000;

/** How long any other request may take. */
const REQUEST_TIMEOUT_MS = 10_000;

export class VideoPlayer implements IVideoPlayer {

    /** Names this video player in what the coordinator service keeps. */
    readonly id: string;
    private readonly _playTimeoutMs: number;
    private readonly _secret: string;
    private readonly _url: string;

    /**
     * Creates the client.
     *
     * @param {string} url - The video player service's base URL.
     * @param {string} secret - Its bearer secret.
     * @param {Object} [options] - Options.
     * @param {string} [options.id] - The worker's id.
     * @param {number} [options.playTimeoutMs] - How long to wait for `/play` to answer.
     */
    constructor(url: string, secret: string, options: { id?: string; playTimeoutMs?: number; } = {}) {
        this.id = options.id ?? 'video-player';
        this._url = url;
        this._secret = secret;
        this._playTimeoutMs = options.playTimeoutMs ?? DEFAULT_PLAY_TIMEOUT_MS;
    }

    /**
     * Sends a request to the control API.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {object} [body] - The JSON body.
     * @param {number} [timeoutMs] - How long to wait for the answer.
     * @returns {Promise<Response>}
     */
    private async _request(method: string, path: string, body?: object,
            timeoutMs = REQUEST_TIMEOUT_MS): Promise<Response> {
        try {
            return await fetch(`${this._url}${path}`, {
                body: body && JSON.stringify(body),
                headers: { authorization: `Bearer ${this._secret}`, 'content-type': 'application/json' },
                method,
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch {
            throw new VideoPlayerUnavailableError('unreachable');
        }
    }

    /**
     * Asks the video player to play a video in a room.
     *
     * @param {Object} request - The room, a token for it and the video's URL.
     * @returns {Promise<void>}
     */
    async play(request: { room: string; token: string; videoUrl: string; }): Promise<void> {
        let response: Response;

        try {
            response = await this._request('POST', '/play', request, this._playTimeoutMs);
        } catch (error) {
            // The player may still start the video after we gave up on it: take it down so it does not play unseen.
            await this.stop(request.room).catch(() => undefined);
            throw error;
        }

        if (response.status === 503) {
            throw new VideoPlayerUnavailableError('at_capacity');
        }
        if (response.status === 409) {
            throw new VideoPlayerUnavailableError('already_playing');
        }
        if (!response.ok) {
            throw new VideoPlayerUnavailableError('rejected');
        }
    }

    /**
     * How many more videos the video player can play: its capacity minus the ones it plays.
     *
     * @returns {Promise<number>}
     */
    async room(): Promise<number> {
        const response = await this._request('GET', '/health');

        if (!response.ok) {
            throw new VideoPlayerUnavailableError('rejected');
        }

        const { activeRooms, maxRooms } = await response.json() as { activeRooms?: number; maxRooms?: number; };

        return Number(maxRooms) - Number(activeRooms);
    }

    /**
     * Lists the rooms a video is playing in.
     *
     * @returns {Promise<string[]>}
     */
    async playingRooms(): Promise<string[]> {
        const response = await this._request('GET', '/health');

        if (!response.ok) {
            throw new VideoPlayerUnavailableError('rejected');
        }

        const body = await response.json() as { rooms?: unknown; };

        return Array.isArray(body.rooms) ? body.rooms.filter((r): r is string => typeof r === 'string') : [];
    }

    /**
     * Asks the video player to stop the video of a room.
     *
     * @param {string} room - The room.
     * @returns {Promise<void>}
     */
    async stop(room: string): Promise<void> {
        const response = await this._request('POST', '/stop', { room });

        if (!response.ok && response.status !== 404) {
            throw new VideoPlayerUnavailableError('rejected');
        }
    }
}
