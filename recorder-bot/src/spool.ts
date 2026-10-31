/**
 * Retries the evidence recordings left in the spool.
 *
 * When the evidence storage root is unavailable as a consultation ends, its finalised folder stays in the spool and
 * the consultation is `spooled`. The retrier tries to move every such folder into the storage root when the service
 * starts, and again at every interval, until it succeeds. It also finds the folders spooled before the service last
 * stopped, which the control API no longer knows about; it logs those by consultation id.
 */
import { readdir } from 'node:fs/promises';
import path from 'node:path';

import type { Consultations } from './consultations.ts';
import { evidenceLocation, moveIntoStorage, readManifest } from './evidence.ts';
import { errorCode, log } from './log.ts';

/** A consultation's spool folder is named after its consultation id. */
export const CONSULTATION_FOLDER = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class SpoolRetrier {
    private readonly consultations: Consultations;
    private readonly intervalMs: number;
    private readonly spoolDir: string;
    private readonly storageRoot: string;

    /** Folders that cannot be retried, so that each is logged once. */
    private readonly reported = new Set<string>();
    private sweeping?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;

    /**
     * Creates a retrier. Call {@link start} to start it.
     *
     * @param {Object} options - Options.
     * @param {Consultations} options.consultations - The consultations this service knows about.
     * @param {number} options.intervalMs - How long to wait between retries, in milliseconds.
     * @param {string} options.spoolDir - The spool.
     * @param {string} options.storageRoot - The evidence storage root.
     */
    constructor({ consultations, intervalMs, spoolDir, storageRoot }: {
        consultations: Consultations;
        intervalMs: number;
        spoolDir: string;
        storageRoot: string;
    }) {
        this.consultations = consultations;
        this.intervalMs = intervalMs;
        this.spoolDir = spoolDir;
        this.storageRoot = storageRoot;
    }

    /**
     * Retries the spool now, then at every interval.
     *
     * @returns {void}
     */
    start() {
        this.sweep();
        this.timer = setInterval(() => this.sweep(), this.intervalMs);
    }

    /**
     * Stops retrying, once the retry under way, if any, is done.
     *
     * @returns {Promise<void>}
     */
    async stop(): Promise<void> {
        clearInterval(this.timer);
        await this.sweeping;
    }

    /**
     * Retries every spooled folder, unless a retry is still under way.
     *
     * @returns {void}
     */
    private sweep() {
        this.sweeping ??= this.retryAll().finally(() => {
            this.sweeping = undefined;
        });
    }

    /**
     * Retries every folder in the spool whose consultation is over.
     *
     * @returns {Promise<void>}
     */
    private async retryAll(): Promise<void> {
        let ids: string[];

        try {
            ids = (await readdir(this.spoolDir, { withFileTypes: true }))
                .filter(entry => entry.isDirectory() && CONSULTATION_FOLDER.test(entry.name))
                .map(entry => entry.name);
        } catch (error) {
            log.error('could not read the spool', { error: errorCode(error) });

            return;
        }
        for (const id of ids) {
            // A consultation still running, or finalising, handles its own folder.
            if (!this.consultations.get(id)?.isActive()) {
                await this.retry(id);
            }
        }
    }

    /**
     * Moves one spooled folder into the storage root.
     *
     * @param {string} consultationId - The folder's consultation.
     * @returns {Promise<void>}
     */
    private async retry(consultationId: string): Promise<void> {
        const folder = path.join(this.spoolDir, consultationId);
        let manifest;

        try {
            manifest = await readManifest(folder);
        } catch (error) {
            this.reportOnce(consultationId, 'a spooled evidence recording has an unreadable manifest; leaving it there',
                errorCode(error));

            return;
        }
        if (!manifest) {
            // The service stopped before it finalised the consultation, or could not finalise it.
            this.reportOnce(consultationId, 'an evidence recording in the spool was never finalised; leaving it there');

            return;
        }

        const location = evidenceLocation(manifest.room, manifest.start);

        try {
            await moveIntoStorage(folder, this.storageRoot, location);
        } catch (error) {
            log.warn('could not move a spooled evidence recording to the storage root; will retry', {
                consultationId,
                error: errorCode(error)
            });

            return;
        }
        log.info('spooled evidence recording stored', { consultationId });
        this.consultations.get(consultationId)?.markStored(location);
    }

    /**
     * Logs, once per folder, why a spooled folder is not retried.
     *
     * @param {string} consultationId - The folder's consultation.
     * @param {string} message - Why.
     * @param {string} error - The error, if any.
     * @returns {void}
     */
    private reportOnce(consultationId: string, message: string, error?: string) {
        if (!this.reported.has(consultationId)) {
            this.reported.add(consultationId);
            log.warn(message, { consultationId, error });
        }
    }
}
