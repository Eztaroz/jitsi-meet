/**
 * The recorder bot service: runs the control API and records each consultation it is asked to.
 */
import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { Consultations } from './consultations.ts';
import { log } from './log.ts';

const config = loadConfig();
const consultations = new Consultations(config);
const api = createApi({ consultations, secret: config.apiSecret });

api.listen(config.apiPort, () => log.info('control API listening', { port: config.apiPort }));

let shuttingDown = false;

/**
 * Stops every consultation, then exits.
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
    await consultations.shutdown();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
