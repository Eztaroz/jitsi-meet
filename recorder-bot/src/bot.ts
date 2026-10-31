/**
 * Runs the in-page recorder bot (static/recorder-bot.html) in its own headless Chromium, one browser process per
 * consultation so that a crash stays contained.
 */
import { type Browser, chromium } from 'playwright-core';

import type { IConfig } from './config.ts';
import type { TrackKind } from './consultationLifecycle.ts';
import { log } from './log.ts';

/**
 * What the in-page bot reports. The page records each remote track with its own recorder, which it names with a
 * recorder id; the track's chunks arrive through {@link IBotCallbacks.onChunk} under that id.
 */
export type PageEvent =
    | { type: 'connected'; }
    | { error: string; type: 'connection_failed'; }

    /** The bot may not start the room itself, and keeps trying to join until a participant who may has. */
    | { type: 'waiting_for_host'; }
    | { meetingId?: string; type: 'joined'; }
    | { meetingId?: string; type: 'meeting_id'; }
    | {
        displayName?: string;
        endpointId: string;
        hidden: boolean;

        /** The identity in the participant's presence, as lib-jitsi-meet reports it. */
        identity?: unknown;
        type: 'participant_joined';
    }
    | { endpointId: string; type: 'participant_left'; }
    | { endpointId: string; kind: TrackKind; recorderId: string; type: 'track_started'; }
    | { recorderId: string; type: 'track_stopped'; }
    | { height: number; recorderId: string; type: 'video_resolution'; width: number; }
    | { error: string; recorderId: string; type: 'recorder_error'; }
    | { type: 'room_destroyed'; }
    | { type: 'kicked'; }
    | { error: string; type: 'conference_failed'; }
    | { error: string; type: 'disconnected'; };

export interface IBotParams {
    consultationId: string;
    room: string;
}

export interface IBot {

    /**
     * Resolves when the browser has gone, whether it was closed or it crashed.
     */
    exited: Promise<void>;

    /**
     * Stops the bot and closes its browser. The page first closes every recorder and delivers their last chunks.
     *
     * @param {Object} options - Options.
     * @param {boolean} options.leave - Whether to leave the conference first. Skipped when the room is already gone.
     * @returns {Promise<void>}
     */
    stop: (options: { leave: boolean; }) => Promise<void>;
}

export interface IBotCallbacks {

    /**
     * A recorder delivered a chunk. The next chunk of the same recorder comes once the returned promise settles, so
     * chunks arrive in order.
     */
    onChunk: (recorderId: string, data: Buffer) => Promise<void>;

    /** The browser went away without being stopped. */
    onCrash: (reason: string) => void;

    /** Something happened in the conference. */
    onEvent: (event: PageEvent) => void;
}

/** How long the page may take to close its recorders, deliver their last chunks and leave. */
const STOP_TIMEOUT_MS = 15_000;

/**
 * Launches a browser for one consultation and starts the in-page bot in it.
 *
 * @param {IConfig} config - Service settings.
 * @param {IBotParams} params - The consultation.
 * @param {IBotCallbacks} callbacks - Where to report.
 * @returns {Promise<IBot>}
 */
export async function launchBot(config: IConfig, params: IBotParams, callbacks: IBotCallbacks): Promise<IBot> {
    const { consultationId } = params;
    const browser: Browser = await chromium.launch({
        args: [
            '--autoplay-policy=no-user-gesture-required',
            ...config.ignoreCertificateErrors ? [ '--ignore-certificate-errors' ] : []
        ],
        executablePath: config.chromiumPath
    });
    let stopping = false;
    const exited = new Promise<void>(resolve => {
        browser.on('disconnected', () => {
            if (!stopping) {
                callbacks.onCrash('browser_disconnected');
            }
            resolve();
        });
    });

    try {
        const context = await browser.newContext({ ignoreHTTPSErrors: config.ignoreCertificateErrors });
        const page = await context.newPage();

        page.on('crash', () => {
            if (!stopping) {
                callbacks.onCrash('page_crashed');
            }
        });
        page.on('pageerror', error => log.warn('bot page error', { consultationId, error: error.name }));
        await page.exposeFunction('recorderBotEvent', (event: PageEvent) => callbacks.onEvent(event));
        await page.exposeFunction('recorderBotChunk',
            (recorderId: string, base64: string) => callbacks.onChunk(recorderId, Buffer.from(base64, 'base64')));
        await page.goto(`${config.jitsiUrl}/static/recorder-bot.html`);
        await page.evaluate(p => {
            // @ts-ignore The page defines it.
            window.recorderBot.start(p);
        }, {
            consultationId,
            jid: config.botJid,
            maxHeight: config.maxHeight,
            password: config.botPassword,
            room: params.room
        });

        return {
            exited,
            async stop({ leave }) {
                if (stopping) {
                    return exited;
                }
                stopping = true;

                let timeout: ReturnType<typeof setTimeout> | undefined;

                await Promise.race([
                    page.evaluate(l => {
                        // @ts-ignore The page defines it.
                        return window.recorderBot.stop({ leave: l });
                    }, leave).catch(() => undefined),
                    new Promise(resolve => {
                        timeout = setTimeout(() => {
                            log.warn('bot page did not stop in time', { consultationId });
                            resolve(undefined);
                        }, STOP_TIMEOUT_MS);
                    })
                ]);
                clearTimeout(timeout);
                await browser.close().catch(() => undefined);
                await exited;
            }
        };
    } catch (error) {
        stopping = true;
        await browser.close().catch(() => undefined);
        throw error;
    }
}
