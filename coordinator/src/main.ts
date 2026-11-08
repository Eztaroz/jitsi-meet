/**
 * The coordinator service: runs the API.
 */
import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { CoordinatorService } from './coordinatorService.ts';
import { log } from './log.ts';
import { Prosody } from './prosody.ts';
import { RecorderBot } from './recorderBot.ts';
import { keyLookup } from './screenAuth.ts';
import { Store } from './store.ts';

const config = loadConfig();
const store = new Store(config.dataDir);
const service = new CoordinatorService({
    auditKey: config.auditKey,
    layout: config.layout,
    prepareWaitMs: config.prepareWaitMs,
    prosody: new Prosody({ ...config.signingKey, url: config.prosodyUrl }),
    recorderBot: new RecorderBot(config.recorderBotUrl, config.recorderBotSecret),
    retentionMs: config.retentionMs,
    retentionSweepMs: config.retentionSweepMs,
    roleMarkers: config.roleMarkers,
    signingKey: config.signingKey,
    store,
    timeZone: config.timeZone,
    token: config.token
});

service.resume().catch(error => log.error('could not resume the moves', { error: (error as Error).name }));
service.startDayEnds();
service.startRetention();
const issuer = config.screen && {
    acceptedAudiences: config.screen.acceptedAudiences,
    acceptedIssuers: config.screen.acceptedIssuers,
    keyFor: keyLookup(config.screen.keys)
};
const api = createApi({
    screen: issuer && config.screen && { ...issuer, marker: config.screen.marker },

    // A patient's page sends the survey with the patient's token, from the same issuer as the coordinators'.
    survey: issuer && config.roleMarkers.patient && { ...issuer, marker: config.roleMarkers.patient },
    secret: config.apiSecret,
    service
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
    service.stop();
    api.close(() => {
        store.close();
        process.exit(0);
    });
    api.closeAllConnections();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
