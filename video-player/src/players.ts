/**
 * The rooms the video player is playing a video in. One headless browser per room, up to a capacity limit.
 */
import { errorCode, log } from './log.ts';

export interface IPlayerParams {

    /** The room to join. */
    room: string;

    /** The token the coordinator service issued for this room. It carries the video player's role marker. */
    token: string;

    /** Where the video file is hosted. */
    videoUrl: string;
}

export interface IPlayerCallbacks {

    /** The video ended. */
    onEnded: () => void;

    /** The browser or its connection failed, so the video cannot play on. */
    onFailed: (reason: string) => void;
}

export interface IPlayerBrowser {

    /**
     * Leaves the room and closes the browser.
     *
     * @returns {Promise<void>}
     */
    stop: () => Promise<void>;
}

/** Opens a browser that joins a room and plays a video in it. Faked in tests. */
export type LaunchPlayer = (params: IPlayerParams, callbacks: IPlayerCallbacks) => Promise<IPlayerBrowser>;

export class AtCapacityError extends Error {}
export class AlreadyPlayingError extends Error {}

export class Players {
    private readonly launch: LaunchPlayer;
    private readonly maxRooms: number;

    /** A room maps to its browser once the browser has started; to undefined while it starts. */
    private readonly rooms = new Map<string, IPlayerBrowser | undefined>();

    /**
     * The rooms being played in.
     *
     * @param {Object} options - Options.
     * @param {LaunchPlayer} options.launch - Starts a browser.
     * @param {number} options.maxRooms - How many rooms at once.
     */
    constructor({ launch, maxRooms }: { launch: LaunchPlayer; maxRooms: number; }) {
        this.launch = launch;
        this.maxRooms = maxRooms;
    }

    /**
     * The rooms in use.
     *
     * @returns {string[]}
     */
    active(): string[] {
        return [ ...this.rooms.keys() ];
    }

    /**
     * Starts playing a video in a room.
     *
     * @param {IPlayerParams} params - The room, its token and the video.
     * @throws {AlreadyPlayingError} When the room already has a video.
     * @throws {AtCapacityError} When the service plays in as many rooms as it may.
     * @returns {Promise<void>} Once the browser has started.
     */
    async play(params: IPlayerParams): Promise<void> {
        const { room } = params;

        if (this.rooms.has(room)) {
            throw new AlreadyPlayingError();
        }
        if (this.rooms.size >= this.maxRooms) {
            throw new AtCapacityError();
        }

        // Take the slot before the browser starts, so that concurrent requests cannot exceed the capacity.
        this.rooms.set(room, undefined);

        try {
            const browser = await this.launch(params, {
                onEnded: () => this.finish(room),
                onFailed: reason => {
                    log.warn('video player failed', { reason });
                    this.finish(room);
                }
            });

            // The video may have ended or the browser failed before the launch settled.
            if (this.rooms.has(room)) {
                this.rooms.set(room, browser);
            } else {
                await browser.stop().catch(() => undefined);
            }
        } catch (error) {
            this.rooms.delete(room);
            throw error;
        }
    }

    /**
     * Stops the video in a room.
     *
     * @param {string} room - The room.
     * @returns {Promise<boolean>} Whether the room was playing.
     */
    async stop(room: string): Promise<boolean> {
        if (!this.rooms.has(room)) {
            return false;
        }

        await this.finish(room);

        return true;
    }

    /**
     * Stops every room, for a shutdown.
     *
     * @returns {Promise<void>}
     */
    async shutdown(): Promise<void> {
        await Promise.all(this.active().map(room => this.finish(room)));
    }

    /**
     * Frees a room and closes its browser.
     *
     * @param {string} room - The room.
     * @returns {Promise<void>}
     */
    private async finish(room: string): Promise<void> {
        const browser = this.rooms.get(room);

        this.rooms.delete(room);
        await browser?.stop().catch(error => log.warn('video player did not stop cleanly', { error: errorCode(error) }));
    }
}
