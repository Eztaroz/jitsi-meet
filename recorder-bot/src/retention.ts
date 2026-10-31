/**
 * The retention sweeper (ADR 0003): deletes evidence recordings once they are older than the retention period, so
 * that the hospital keeps to it without anyone deleting files by hand.
 *
 * It looks only at what the service itself writes, and deletes only what matches it:
 *
 * - in the storage root, `<backend-safe HN>/<consultation start>/` folders whose manifest says they belong exactly
 *   there, once their consultation start is older than the retention period;
 * - in the spool, and in the storage root's staging folder, consultation folders in which nothing has changed for
 *   longer than the retention period: what a crash, or an outage of the storage root, left behind.
 *
 * It never deletes the folder of a consultation that has not reached a final status, never follows a symbolic link,
 * and leaves alone, and logs, every other folder. Entries whose names start with "." are left alone without a log:
 * the service's own staging and trash folders, and the file server's, such as snapshots.
 *
 * To delete a folder, the sweeper first renames it into a trash folder next to it, `.deleting`, then deletes it; each
 * sweep starts by emptying the trash. So a deletion cut short, by a crash for example, is finished by the next sweep,
 * and never leaves a partial evidence recording in place.
 */
import { createHash } from 'node:crypto';
import { type Dirent } from 'node:fs';
import { lstat, mkdir, readdir, rename, rm, rmdir } from 'node:fs/promises';
import path from 'node:path';

import type { Consultations } from './consultations.ts';
import { INCOMING_DIR, evidenceLocation, readManifest } from './evidence.ts';
import { errorCode, log } from './log.ts';
import { CONSULTATION_FOLDER } from './spool.ts';

/** Where a folder is. */
type Place = 'spool' | 'staging' | 'storage_root';

/** The trash folder, in the storage root and in the spool. */
const TRASH_DIR = '.deleting';

/**
 * Names a folder in the logs without naming an HN: the start of the SHA-256 of its path relative to the storage root,
 * or to the spool.
 *
 * @param {string} relative - The folder's relative path.
 * @returns {string}
 */
export function folderRef(relative: string): string {
    return createHash('sha256').update(relative).digest('hex').slice(0, 16);
}

/**
 * Whether a path is a folder, and not a symbolic link to one.
 *
 * @param {string} dir - The path.
 * @returns {Promise<boolean>}
 */
function isRealFolder(dir: string): Promise<boolean> {
    return lstat(dir).then(stats => stats.isDirectory(), () => false);
}

/**
 * Returns when anything in a folder last changed: the folder itself, or anything in it.
 *
 * @param {string} folder - The folder.
 * @returns {Promise<number>} In milliseconds since the epoch.
 */
async function lastChange(folder: string): Promise<number> {
    let newest = (await lstat(folder)).mtimeMs;

    for (const entry of await readdir(folder, { recursive: true })) {
        newest = Math.max(newest, (await lstat(path.join(folder, entry))).mtimeMs);
    }

    return newest;
}

export class RetentionSweeper {
    private readonly consultations: Consultations;
    private readonly retentionMs: number;
    private readonly spoolDir: string;
    private readonly storageRoot: string;

    /** Folders left alone, so that each is logged once. */
    private readonly reported = new Set<string>();

    /**
     * Creates a sweeper.
     *
     * @param {Object} options - Options.
     * @param {Consultations} options.consultations - The consultations this service knows about.
     * @param {number} options.retentionMs - The retention period, in milliseconds.
     * @param {string} options.spoolDir - The spool.
     * @param {string} options.storageRoot - The evidence storage root.
     */
    constructor({ consultations, retentionMs, spoolDir, storageRoot }: {
        consultations: Consultations;
        retentionMs: number;
        spoolDir: string;
        storageRoot: string;
    }) {
        this.consultations = consultations;
        this.retentionMs = retentionMs;
        this.spoolDir = spoolDir;
        this.storageRoot = storageRoot;
    }

    /**
     * Deletes what is older than the retention period, in the storage root and in the spool.
     *
     * @returns {Promise<void>}
     */
    async sweep(): Promise<void> {
        const cutoff = Date.now() - this.retentionMs;
        const staging = path.join(this.storageRoot, INCOMING_DIR);

        await this.emptyTrash(this.storageRoot);
        await this.emptyTrash(this.spoolDir);
        await this.sweepStorageRoot(cutoff);
        await this.sweepConsultationFolders(this.spoolDir, 'spool', cutoff);
        if (await isRealFolder(staging)) {
            await this.sweepConsultationFolders(staging, 'staging', cutoff);
        }
    }

    /**
     * Finishes deleting what an earlier sweep put in a trash folder.
     *
     * @param {string} dir - The storage root, or the spool.
     * @returns {Promise<void>}
     */
    private async emptyTrash(dir: string): Promise<void> {
        const trash = path.join(dir, TRASH_DIR);

        if (!await isRealFolder(trash)) {
            return;
        }
        for (const entry of await readdir(trash)) {
            await rm(path.join(trash, entry), { force: true, recursive: true });
        }
    }

    /**
     * Deletes the evidence recordings in the storage root whose consultation started before the cutoff.
     *
     * @param {number} cutoff - The cutoff, in milliseconds since the epoch.
     * @returns {Promise<void>}
     */
    private async sweepStorageRoot(cutoff: number): Promise<void> {
        const patients = await this.list(this.storageRoot, 'storage_root');

        for (const patient of patients) {
            if (patient.name.startsWith('.')) {
                continue;
            }
            if (!patient.isDirectory()) {
                this.leave(patient.name, 'storage_root', 'not_a_folder');
                continue;
            }

            const patientFolder = path.join(this.storageRoot, patient.name);
            let deleted = false;

            for (const start of await this.list(patientFolder, 'storage_root')) {
                deleted = await this.sweepEvidence(patient.name, start, cutoff) || deleted;
            }
            if (deleted) {
                // Only when it is empty now.
                await rmdir(patientFolder).catch(() => undefined);
            }
        }
    }

    /**
     * Deletes one evidence recording of the storage root, if its consultation started before the cutoff.
     *
     * @param {string} patient - The name of the patient's folder.
     * @param {Dirent} entry - The entry in it.
     * @param {number} cutoff - The cutoff, in milliseconds since the epoch.
     * @returns {Promise<boolean>} Whether it was deleted.
     */
    private async sweepEvidence(patient: string, entry: Dirent, cutoff: number): Promise<boolean> {
        const relative = path.posix.join(patient, entry.name);
        const folder = path.join(this.storageRoot, patient, entry.name);

        if (!entry.isDirectory()) {
            this.leave(relative, 'storage_root', 'not_a_folder');

            return false;
        }

        let manifest;

        try {
            manifest = await readManifest(folder);
        } catch (error) {
            this.leave(relative, 'storage_root', 'unreadable_manifest', { error: errorCode(error) });

            return false;
        }
        if (!manifest) {
            this.leave(relative, 'storage_root', 'no_manifest');

            return false;
        }

        const { consultationId, room, start } = manifest;

        if (evidenceLocation(room, start) !== relative) {
            this.leave(relative, 'storage_root', 'misplaced', { consultationId });

            return false;
        }
        if (start.getTime() >= cutoff || this.consultations.get(consultationId)?.isActive()) {
            return false;
        }

        return this.delete(folder, this.storageRoot, 'storage_root', consultationId);
    }

    /**
     * Deletes the consultation folders of the spool, or of the staging folder, in which nothing has changed since
     * the cutoff.
     *
     * @param {string} dir - The spool, or the staging folder.
     * @param {Place} place - Which.
     * @param {number} cutoff - The cutoff, in milliseconds since the epoch.
     * @returns {Promise<void>}
     */
    private async sweepConsultationFolders(dir: string, place: Place, cutoff: number): Promise<void> {
        for (const entry of await this.list(dir, place)) {
            const id = entry.name;
            const relative = place === 'staging' ? path.posix.join(INCOMING_DIR, id) : id;

            if (id.startsWith('.')) {
                continue;
            }
            if (!entry.isDirectory() || !CONSULTATION_FOLDER.test(id)) {
                this.leave(relative, place, entry.isDirectory() ? 'not_a_consultation' : 'not_a_folder');
                continue;
            }
            if (this.consultations.get(id)?.isActive()) {
                continue;
            }

            const folder = path.join(dir, id);
            let changed;

            try {
                changed = await lastChange(folder);
            } catch (error) {
                log.warn('could not read a folder to sweep; will try again', {
                    consultationId: id,
                    error: errorCode(error),
                    place
                });
                continue;
            }
            if (changed < cutoff) {
                await this.delete(folder, place === 'spool' ? this.spoolDir : this.storageRoot, place, id);
            }
        }
    }

    /**
     * Lists a folder.
     *
     * @param {string} dir - The folder.
     * @param {Place} place - Where it is, for the logs.
     * @returns {Promise<Dirent[]>} Empty when it cannot be read, or is not there.
     */
    private async list(dir: string, place: Place): Promise<Dirent[]> {
        try {
            return await readdir(dir, { withFileTypes: true });
        } catch (error) {
            log.warn('could not read a folder to sweep; will try again', { error: errorCode(error), place });

            return [];
        }
    }

    /**
     * Deletes a folder: renames it into the trash, then deletes it there.
     *
     * @param {string} folder - The folder.
     * @param {string} dir - The storage root or the spool, whichever the folder is in.
     * @param {Place} place - Where it is.
     * @param {string} consultationId - Its consultation.
     * @returns {Promise<boolean>} Whether it was deleted.
     */
    private async delete(folder: string, dir: string, place: Place, consultationId: string): Promise<boolean> {
        const trash = path.join(dir, TRASH_DIR);
        const trashed = path.join(trash, consultationId);

        try {
            await mkdir(trash, { recursive: true });
            if (!await isRealFolder(trash)) {
                throw Object.assign(new Error('the trash is not a folder'), { code: 'ENOTDIR' });
            }
            await rm(trashed, { force: true, recursive: true });
            await rename(folder, trashed);
            await rm(trashed, { force: true, recursive: true });
        } catch (error) {
            log.error('could not delete a folder older than the retention period; will try again', {
                consultationId,
                error: errorCode(error),
                place
            });

            return false;
        }
        log.info('deleted a folder older than the retention period', { consultationId, place });

        return true;
    }

    /**
     * Logs, once, a folder the sweeper leaves alone because it does not match what the service writes.
     *
     * @param {string} relative - Its path relative to the storage root, or to the spool.
     * @param {Place} place - Where it is.
     * @param {string} reason - Why it is left alone.
     * @param {Object} fields - More to log.
     * @returns {void}
     */
    private leave(relative: string, place: Place, reason: string, fields: Record<string, string> = {}) {
        const key = `${place}:${relative}`;

        if (!this.reported.has(key)) {
            this.reported.add(key);
            log.warn('leaving alone a folder that does not match the evidence layout', {
                ...fields,
                folder: folderRef(relative),
                place,
                reason
            });
        }
    }
}
