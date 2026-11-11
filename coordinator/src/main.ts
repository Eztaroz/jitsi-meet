/**
 * The coordinator service: runs the API.
 */
import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { CoordinatorService } from './coordinatorService.ts';
import { log } from './log.ts';
import { openStore } from './openStore.ts';
import { Prosody } from './prosody.ts';
import { RecorderBot } from './recorderBot.ts';
import { keyLookup } from './screenAuth.ts';
import type { IStore } from './store.ts';
import { VideoPlayer } from './videoPlayer.ts';
import { WorkerRegistry } from './workerRegistry.ts';
import { RecorderBotPool, VideoPlayerPool } from './workers.ts';

const config = loadConfig();
let store: IStore;

try {
    store = openStore(config);
} catch (error) {
    // The database cannot be reached, or its schema cannot be brought up to date: there is no state to decide from.
    log.error('refusing to start: cannot open the store', { reason: (error as Error).message });
    process.exit(1);
}

// With a list of worker secrets, the workers are the ones that send heartbeats; else a fixed list (ADR 0014).
const registry = config.workerSecretsFile
    ? new WorkerRegistry({ file: config.workerSecretsFile, playTimeoutMs: config.videoPlayer?.playTimeoutMs })
    : undefined;
let service: CoordinatorService;

try {
    service = new CoordinatorService({
        auditKey: config.auditKey,
        layout: config.layout,
        prosody: new Prosody({ ...config.signingKey, url: config.prosodyUrl }),
        recorderBot: new RecorderBotPool(registry
            ? () => registry.recorderBots()
            : config.recorderBots.map(w => new RecorderBot(w.url, w.secret, w.id))),
        retentionMs: config.retentionMs,
        retentionSweepMs: config.retentionSweepMs,
        roleMarkers: config.roleMarkers,
        signingKey: config.signingKey,
        store,
        timeZone: config.timeZone,
        token: config.token,
        videoBaseUrl: config.videoPlayer?.baseUrl,
        videoPlayer: config.videoPlayer && new VideoPlayerPool(registry
            ? () => registry.videoPlayers()
            : config.videoPlayer.workers.map(
                w => new VideoPlayer(w.url, w.secret, { id: w.id, playTimeoutMs: config.videoPlayer!.playTimeoutMs })))
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
    pipelineSecret: config.pipelineSecret,
    screen: issuer && config.screen && { ...issuer, marker: config.screen.marker },

    // A patient's page sends the survey with the patient's token, from the same issuer as the coordinators'.
    survey: issuer && config.roleMarkers.patient && { ...issuer, marker: config.roleMarkers.patient },
    secret: config.apiSecret,
    service,

    // Staff act with their own token from the same issuer, which carries the staff marker.
    staff: issuer && config.roleMarkers.staff && { ...issuer, marker: config.roleMarkers.staff },
    workers: registry
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
