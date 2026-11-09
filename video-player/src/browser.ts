/**
 * Runs the in-page video player (static/video-player.html) in its own headless Chromium, one browser process per room
 * so that a crash stays contained.
 */
import { type Browser, chromium } from 'playwright-core';

import type { IConfig } from './config.ts';
import { log } from './log.ts';
import type { IPlayerBrowser, IPlayerCallbacks, IPlayerParams } from './players.ts';

/** What the in-page player reports. */
type PageEvent =
    | { type: 'ended'; }
    | { error: string; type: 'failed'; };

/** How long the page may take to leave the conference. */
const STOP_TIMEOUT_MS = 10_000;

/**
 * Launches a browser for one room and starts the in-page player in it.
 *
 * @param {IConfig} config - Service settings.
 * @param {IPlayerParams} params - The room, its token and the video.
 * @param {IPlayerCallbacks} callbacks - Where to report.
 * @returns {Promise<IPlayerBrowser>}
 */
export async function launchPlayer(
        config: IConfig, params: IPlayerParams, callbacks: IPlayerCallbacks): Promise<IPlayerBrowser> {
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
                callbacks.onFailed('browser_disconnected');
            }
            resolve();
        });
    });

    try {
        const context = await browser.newContext({ ignoreHTTPSErrors: config.ignoreCertificateErrors });
        const page = await context.newPage();

        page.on('crash', () => {
            if (!stopping) {
                callbacks.onFailed('page_crashed');
            }
        });
        page.on('pageerror', error => log.warn('player page error', { error: error.name }));
        await page.exposeFunction('videoPlayerEvent', (event: PageEvent) => {
            if (stopping) {
                return;
            }
            if (event.type === 'ended') {
                callbacks.onEnded();
            } else {
                callbacks.onFailed(event.error);
            }
        });
        await page.goto(`${config.jitsiUrl}/static/video-player.html`);
        await page.evaluate(p => {
            // @ts-ignore The page defines it.
            window.videoPlayer.start(p);
        }, params);

        return {
            async stop() {
                if (stopping) {
                    return exited;
                }
                stopping = true;

                let timeout: ReturnType<typeof setTimeout> | undefined;

                await Promise.race([
                    page.evaluate(() => {
                        // @ts-ignore The page defines it.
                        return window.videoPlayer.stop();
                    }).catch(() => undefined),
                    new Promise(resolve => {
                        timeout = setTimeout(resolve, STOP_TIMEOUT_MS);
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
