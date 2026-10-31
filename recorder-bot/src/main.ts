/**
 * The recorder bot service: runs the control API and records each consultation it is asked to.
 */
import { mkdirSync } from 'node:fs';

import { createApi } from './api.ts';
import { loadConfig } from './config.ts';
import { Consultations } from './consultations.ts';
import { log } from './log.ts';
import { SpoolRetrier } from './spool.ts';

const config = loadConfig();

// The spool is local; the storage root is not created here (see moveIntoStorage).
mkdirSync(config.spoolDir, { recursive: true });

const consultations = new Consultations(config);
const api = createApi({ consultations, maxConsultations: config.maxConsultations, secret: config.apiSecret });

const retrier = new SpoolRetrier({
    consultations,
    intervalMs: config.storeRetryMs,
    spoolDir: config.spoolDir,
    storageRoot: config.storageRoot
});

api.listen(config.apiPort, () => log.info('control API listening', { port: config.apiPort }));

// Including what was spooled before the service last stopped.
retrier.start();

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
    await retrier.stop();
    await consultations.shutdown();
    process.exit(0);
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
