/**
 * Runs the in-page recorder bot (static/recorder-bot.html) in its own headless Chromium, one browser process per
 * consultation so that a crash stays contained.
 */
import { type Browser, chromium } from 'playwright-core';

import type { IConfig } from './config.ts';
import { log } from './log.ts';

/** What the in-page bot reports. */
export type PageEvent =
    | { type: 'connected'; }
    | { error: string; type: 'connection_failed'; }
    | { meetingId?: string; type: 'joined'; }
    | { displayName?: string; endpointId: string; hidden: boolean; type: 'participant_joined'; }
    | { endpointId: string; type: 'participant_left'; }
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
     * Stops the bot and closes its browser.
     *
     * @param {Object} options - Options.
     * @param {boolean} options.leave - Whether to leave the conference first. Skipped when the room is already gone.
     * @returns {Promise<void>}
     */
    stop: (options: { leave: boolean; }) => Promise<void>;
}

export interface IBotCallbacks {

    /** The browser went away without being stopped. */
    onCrash: (reason: string) => void;

    /** Something happened in the conference. */
    onEvent: (event: PageEvent) => void;
}

const STOP_TIMEOUT_MS = 5000;

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
                if (leave) {
                    await Promise.race([
                        page.evaluate(() => {
                            // @ts-ignore The page defines it.
                            return window.recorderBot.stop({ leave: true });
                        }).catch(() => undefined),
                        new Promise(resolve => setTimeout(resolve, STOP_TIMEOUT_MS))
                    ]);
                }
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
