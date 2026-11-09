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

export class VideoPlayer implements IVideoPlayer {
    private readonly _secret: string;
    private readonly _url: string;

    /**
     * Creates the client.
     *
     * @param {string} url - The video player service's base URL.
     * @param {string} secret - Its bearer secret.
     */
    constructor(url: string, secret: string) {
        this._url = url;
        this._secret = secret;
    }

    /**
     * Sends a request to the control API.
     *
     * @param {string} method - The HTTP method.
     * @param {string} path - The path.
     * @param {object} [body] - The JSON body.
     * @returns {Promise<Response>}
     */
    private async _request(method: string, path: string, body?: object): Promise<Response> {
        try {
            return await fetch(`${this._url}${path}`, {
                body: body && JSON.stringify(body),
                headers: { authorization: `Bearer ${this._secret}`, 'content-type': 'application/json' },
                method,
                signal: AbortSignal.timeout(10_000)
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
        const response = await this._request('POST', '/play', request);

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
