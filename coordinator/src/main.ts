/**
 * The coordinator service: runs the API.
 */
import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { log } from './log.ts';
import { Prosody } from './prosody.ts';
import { RecorderBot } from './recorderBot.ts';
import { Store } from './store.ts';

const config = loadConfig();
const store = new Store(config.dataDir);
const api = createApi({
    prosody: new Prosody({ ...config.signingKey, url: config.prosodyUrl }),
    recorderBot: new RecorderBot(config.recorderBotUrl, config.recorderBotSecret),
    roleMarkers: config.roleMarkers,
    secret: config.apiSecret,
    store
});

api.listen(config.apiPort, () => log.info('API listening', { port: config.apiPort }));

/**
 * Stops the API, then exits.
 *
 * @param {string} signal - The signal received.
 * @returns {void}
 */
function shutdown(signal: string) {
    log.info('shutting down', { signal });
    api.close(() => {
        store.close();
        process.exit(0);
    });
    api.closeAllConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
