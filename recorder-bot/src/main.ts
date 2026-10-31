/**
 * The recorder bot service: runs the control API and records each consultation it is asked to.
 */
import { mkdirSync } from 'node:fs';

import { createApi } from './api.ts';
import { DAY_MS, loadConfig } from './config.ts';
import { Consultations } from './consultations.ts';
import { log } from './log.ts';
import { Periodic } from './periodic.ts';
import { RetentionSweeper } from './retention.ts';
import { SpoolRetrier } from './spool.ts';

const config = loadConfig();

// The spool is local; the storage root is not created here (see moveIntoStorage).
mkdirSync(config.spoolDir, { recursive: true });

const consultations = new Consultations(config);
const api = createApi({ consultations, maxConsultations: config.maxConsultations, secret: config.apiSecret });

const storage = { consultations, spoolDir: config.spoolDir, storageRoot: config.storageRoot };
const retrier = new SpoolRetrier(storage);
const sweeper = new RetentionSweeper({ ...storage, folderRefKey: config.apiSecret, retentionMs: config.retentionMs });

// Both start with what the service left before it last stopped.
const housekeeping = [
    new Periodic('store_retry', () => retrier.retryAll(), config.storeRetryMs),
    new Periodic('retention_sweep', () => sweeper.sweep(), config.retentionSweepMs)
];

api.listen(config.apiPort, () => log.info('control API listening', { port: config.apiPort }));
log.info('retention period', { retentionDays: config.retentionMs / DAY_MS, sweepSeconds: config.retentionSweepMs / 1000 });
for (const task of housekeeping) {
    task.start();
}

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
    await Promise.all(housekeeping.map(task => task.stop()));
    await consultations.shutdown();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
