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
import { VideoPlayer } from './videoPlayer.ts';

const config = loadConfig();
const store = new Store(config.dataDir);
let service: CoordinatorService;

try {
    service = new CoordinatorService({
        auditKey: config.auditKey,
        layout: config.layout,
        prosody: new Prosody({ ...config.signingKey, url: config.prosodyUrl }),
        recorderBot: new RecorderBot(config.recorderBotUrl, config.recorderBotSecret),
        retentionMs: config.retentionMs,
        retentionSweepMs: config.retentionSweepMs,
        roleMarkers: config.roleMarkers,
        signingKey: config.signingKey,
        store,
        timeZone: config.timeZone,
        token: config.token,
        videoBaseUrl: config.videoPlayer?.baseUrl,
        videoPlayer: config.videoPlayer && new VideoPlayer(config.videoPlayer.url, config.videoPlayer.secret)
    });
} catch (error) {
    // The configuration does not fit the encounters that are open: say which stage, and do not start (ADR 0013).
    log.error('refusing to start', { reason: (error as Error).message });
    store.close();
    process.exit(1);
}

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
