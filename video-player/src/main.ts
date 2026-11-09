/**
 * The video player service: runs the control API and plays a video into each room it is asked to.
 */
import { createApi } from './api.ts';
import { launchPlayer } from './browser.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { Players } from './players.ts';

const config = loadConfig();
const players = new Players({
    launch: (params, callbacks) => launchPlayer(config, params, callbacks),
    maxRooms: config.maxRooms
});
const api = createApi({ maxRooms: config.maxRooms, players, secret: config.apiSecret });

api.listen(config.apiPort, () => log.info('control API listening', { port: config.apiPort }));

let shuttingDown = false;

/**
 * Stops every room, then exits.
 *
 * @param {string} signal - The signal received.
 * @returns {Promise<void>}
 */
async function shutdown(signal: string) {
    if (shuttingDown) {
        return;
    }
    shuttingDown = true;
    log.info('shutting down', { signal });
    api.close();
    await players.shutdown();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
