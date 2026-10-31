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
    private readonly spoolDir: string;
    private readonly storageRoot: string;

    /** Folders that cannot be retried, so that each is logged once. */
    private readonly reported = new Set<string>();

    /**
     * Creates a retrier. The service runs {@link retryAll} at start-up and then periodically.
     *
     * @param {Object} options - Options.
     * @param {Consultations} options.consultations - The consultations this service knows about.
     * @param {string} options.spoolDir - The spool.
     * @param {string} options.storageRoot - The evidence storage root.
     */
    constructor({ consultations, spoolDir, storageRoot }: {
        consultations: Consultations;
        spoolDir: string;
        storageRoot: string;
    }) {
        this.consultations = consultations;
        this.spoolDir = spoolDir;
        this.storageRoot = storageRoot;
    }

    /**
     * Retries every folder in the spool whose consultation is over.
     *
     * @returns {Promise<void>}
     */
    async retryAll(): Promise<void> {
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
