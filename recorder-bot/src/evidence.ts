/**
 * The evidence recording of one consultation on disk.
 *
 * While the consultation runs, each track's chunks are appended to a raw file in the consultation's spool folder.
 * Once it has stopped, the folder is finalised in the spool: every file is remuxed, and the timeline and the manifest
 * are written next to them, the manifest last. Then the folder moves into the evidence storage root as a whole, so that
 * the storage root never holds a partial evidence recording. While the storage root is unavailable, the folder stays
 * in the spool and the move is retried (see spool.ts).
 */
import { execFile } from 'node:child_process';
import { appendFile, cp, lstat, mkdir, readFile, readdir, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';

import type {
    IIdentitySummary,
    IParticipant,
    IStaffVisit,
    ITrack,
    StopReason,
    TimelineEntry,
    TrackKind
} from './consultationLifecycle.ts';
import { errorCode, log } from './log.ts';

const execFileAsync = promisify(execFile);

/**
 * Where an evidence recording is copied to first when the spool and the storage root are on different filesystems.
 * It is inside the storage root, so that the last step, a rename, is atomic.
 */
export const INCOMING_DIR = '.incoming';

/**
 * The file that marks the evidence storage root. The operator puts it in the storage root, on the share itself: a
 * share that is not mounted leaves its empty mount point, which has no marker, and the evidence stays in the spool
 * rather than land on the local disk.
 */
export const STORAGE_ROOT_MARKER = '.recorder-bot-storage-root';

const MANIFEST = 'manifest.json';
const RAW_DIR = 'raw';

/**
 * The name of a worker's part: its id, kept to characters that are safe in a folder name.
 *
 * @param {string} workerId - The worker's id.
 * @returns {string}
 */
export function partOf(workerId: string): string {
    return workerId.replace(/[^\w.-]/gu, '_');
}

/** What the manifest is made of. */
export interface IEvidenceInput {

    /** Parts of the consultation that other recorder bots made or will store, which this one knows are missing. */
    awaitingParts?: string[];

    consultationId: string;

    /** When the consultation started, as the coordinator service says: it names the consultation's folder (ADR 0016). */
    consultationStart?: Date;
    end: Date;
    hn: string;
    identities: IIdentitySummary[];

    /** The conference's meeting id, as jitsi-meet and the videobridge log it. */
    meetingId?: string;
    participants: IParticipant[];

    /** This recorder bot's folder under the consultation's, so that parts never overwrite each other (ADR 0016). */
    part?: string;

    /** The patient's room, which names the evidence's place under their HN. */
    room: string;
    staffVisits: IStaffVisit[];
    start: Date;
    stopReason: StopReason;
    timeline: TimelineEntry[];
    tracks: ITrack[];
}

/** One media file, as the manifest lists it. */
interface IManifestFile {
    bytes: number;

    /**
     * What a video file holds, as ffprobe names it: "av1", "vp9" or "vp8", the codec the sender used when the track was
     * copied. Absent for audio, and when the codec could not be read back.
     */
    codec?: string;

    /** In seconds; null when the file could not be read back, or was never written because no media arrived. */
    duration: number | null;
    endpointId: string;
    kind: TrackKind;
    name: string;
    start: Date;
    stop?: Date;
}

/**
 * Returns where a consultation's evidence recording goes, relative to the storage root:
 * `<backend-safe HN>/<consultation start, UTC>`, and a folder of its own for each recorder bot's part of it:
 * `<backend-safe HN>/<consultation start, UTC>/<part>` (ADR 0016). The start is in ISO 8601 basic format, which has no
 * ":"; some file servers refuse ":" in names.
 *
 * @param {string} room - The room name, which is the backend-safe HN.
 * @param {Date} start - When the consultation started.
 * @param {string} [part] - The recorder bot's part.
 * @returns {string}
 */
export function evidenceLocation(room: string, start: Date, part?: string): string {
    const consultation = path.posix.join(room, start.toISOString().replace(/[-:]/g, ''));

    return part ? path.posix.join(consultation, part) : consultation;
}

/**
 * Returns the size of a file, or 0 when there is none.
 *
 * @param {string} file - The file.
 * @returns {Promise<number>}
 */
async function sizeOf(file: string): Promise<number> {
    try {
        return (await stat(file)).size;
    } catch {
        return 0;
    }
}

/**
 * Reads a media file's duration.
 *
 * @param {string} file - The file.
 * @returns {Promise<number|null>} In seconds, or null when ffprobe cannot tell.
 */
async function durationOf(file: string): Promise<number | null> {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file
        ]);
        const duration = Number(stdout.trim());

        return Number.isFinite(duration) ? duration : null;
    } catch {
        return null;
    }
}

/**
 * Reads the codec of a video file.
 *
 * @param {string} file - The file.
 * @returns {Promise<string|undefined>} The codec's name, or undefined when ffprobe cannot tell.
 */
async function videoCodecOf(file: string): Promise<string | undefined> {
    try {
        const { stdout } = await execFileAsync('ffprobe', [
            '-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=codec_name', '-of', 'csv=p=0', file
        ]);

        return stdout.trim() || undefined;
    } catch {
        return undefined;
    }
}

/**
 * Writes a JSON file.
 *
 * @param {string} file - The file.
 * @param {unknown} value - What to write.
 * @returns {Promise<void>}
 */
function writeJson(file: string, value: unknown): Promise<void> {
    return writeFile(file, `${JSON.stringify(value, null, 2)}\n`);
}

/** What the service reads back from a finalised folder's manifest. */
export interface IManifestHeader {
    consultationId: string;

    /** The recorder bot's part of the consultation, when the folder is one. */
    part?: string;
    room: string;

    /** When the consultation started: the folder's name in the storage root is made of it. */
    start: Date;
}

/**
 * Reads back the manifest of a finalised folder. A folder has one only once it is finalised: the manifest is written
 * last, and atomically.
 *
 * @param {string} folder - The folder.
 * @returns {Promise<IManifestHeader|undefined>} Undefined when the folder has no manifest.
 * @throws {Error} When the manifest cannot be read, or is malformed.
 */
export async function readManifest(folder: string): Promise<IManifestHeader | undefined> {
    let text: string;

    try {
        text = await readFile(path.join(folder, MANIFEST), 'utf8');
    } catch (error) {
        if (errorCode(error) === 'ENOENT') {
            return undefined;
        }
        throw error;
    }

    const manifest = JSON.parse(text) as Record<string, unknown> | null;
    const start = new Date(String(manifest?.consultationStart ?? manifest?.start));

    if (typeof manifest?.consultationId !== 'string' || typeof manifest.room !== 'string'
            || Number.isNaN(start.getTime())) {
        throw Object.assign(new Error('the manifest is malformed'), { code: 'EBADMANIFEST' });
    }

    return {
        consultationId: manifest.consultationId,
        part: typeof manifest.part === 'string' ? manifest.part : undefined,
        room: manifest.room,
        start
    };
}

/** What a consultation's manifest says of one part. */
interface IPartSummary {
    end: string;
    folder: string;
    gaps: { end: string; start: string; }[];
    part: string;
    start: string;
    stopReason: string;
}

/**
 * Writes the manifest of a consultation made of the parts stored under its folder: which parts there are, and every
 * gap in them. It is made again from the parts each time one is stored, so that it lists those stored so far, whichever
 * recorder bot stores last; a part still on a lost VM's spool is not in it until that VM stores it, and the manifest says it is
 * missing, so that the evidence recording is incomplete until then (ADR 0016).
 *
 * @param {string} folder - The consultation's folder in the storage root.
 * @returns {Promise<void>}
 */
async function writeConsultationManifest(folder: string): Promise<void> {
    const parts: IPartSummary[] = [];
    const awaiting = new Set<string>();
    let consultation: { consultationId: string; consultationStart: string; room: string; } | undefined;

    for (const entry of await readdir(folder, { withFileTypes: true })) {
        if (!entry.isDirectory()) {
            continue;
        }

        let manifest;

        try {
            manifest = JSON.parse(await readFile(path.join(folder, entry.name, MANIFEST), 'utf8'));
        } catch {
            continue;
        }
        consultation ??= {
            consultationId: manifest.consultationId,
            consultationStart: manifest.consultationStart ?? manifest.start,
            room: manifest.room
        };
        for (const part of Array.isArray(manifest.awaiting) ? manifest.awaiting : []) {
            awaiting.add(String(part));
        }
        parts.push({
            end: manifest.end,
            folder: entry.name,
            gaps: manifest.gaps ?? [],
            part: manifest.part ?? entry.name,
            start: manifest.start,
            stopReason: manifest.stopReason
        });
    }
    if (!consultation) {
        return;
    }
    parts.sort((a, b) => a.start.localeCompare(b.start) || a.part.localeCompare(b.part));

    const tmp = path.join(folder, `${MANIFEST}.${process.pid}.tmp`);

    // A part a recorder bot knew was missing, and that has not been stored yet, is still in a lost worker's spool.
    const stored = new Set(parts.flatMap(p => [ p.part, p.folder ]));
    const missingParts = [ ...awaiting ].filter(part => !stored.has(part)).sort();

    await writeJson(tmp, {
        complete: missingParts.length === 0,
        consultationId: consultation.consultationId,
        missingParts,
        end: parts.map(p => p.end).sort().at(-1),
        gaps: parts.flatMap(p => p.gaps).sort((a, b) => a.start.localeCompare(b.start)),
        parts: parts.map(({ gaps: _gaps, ...p }) => p),
        room: consultation.room,
        start: consultation.consultationStart
    });
    await rename(tmp, path.join(folder, MANIFEST));
}

/**
 * Moves a finalised folder into the storage root, and when it is a recorder bot's part of a consultation, brings the
 * consultation's manifest up to date.
 *
 * @param {string} folder - The finalised folder in the spool, named after its consultation.
 * @param {string} storageRoot - The evidence storage root.
 * @param {string} location - Where in the storage root.
 * @returns {Promise<void>}
 */
export async function storeFolder(folder: string, storageRoot: string, location: string): Promise<void> {
    await moveIntoStorage(folder, storageRoot, location);

    const destination = path.join(storageRoot, location);

    if ((await readManifest(destination).catch(() => undefined))?.part) {
        await writeConsultationManifest(path.dirname(destination));
    }
}

/**
 * Whether a path exists.
 *
 * @param {string} file - The path.
 * @returns {Promise<boolean>}
 */
function exists(file: string): Promise<boolean> {
    return lstat(file).then(() => true, () => false);
}

/**
 * Checks that the storage root is available: a directory, with the marker file in it.
 *
 * @param {string} storageRoot - The evidence storage root.
 * @returns {Promise<void>}
 * @throws {Error} When it is not, with a code that says why.
 */
export async function checkStorageRoot(storageRoot: string): Promise<void> {
    // Never create the storage root itself: if it is a mount point that is not mounted, the evidence would land on
    // the local disk underneath.
    if (!(await stat(storageRoot)).isDirectory()) {
        throw Object.assign(new Error('the storage root is not a directory'), { code: 'ENOTDIR' });
    }
    if (!await exists(path.join(storageRoot, STORAGE_ROOT_MARKER))) {
        throw Object.assign(new Error('the storage root has no marker file'), { code: 'NO_STORAGE_ROOT_MARKER' });
    }
}

/**
 * Moves a finalised folder to its destination in the storage root. When the destination is on another filesystem,
 * the folder is copied into the storage root's staging folder first, then renamed, so that the destination never
 * holds a partial copy; a failed copy is removed.
 *
 * @param {string} folder - The finalised folder in the spool.
 * @param {string} storageRoot - The evidence storage root.
 * @param {string} destination - Where, in the storage root.
 * @returns {Promise<void>}
 */
async function moveFolder(folder: string, storageRoot: string, destination: string): Promise<void> {
    if (await exists(destination)) {
        // An earlier attempt got the folder there, but stopped before it removed the spool's copy.
        if ((await readManifest(destination).catch(() => undefined))?.consultationId === path.basename(folder)) {
            await rm(folder, { force: true, recursive: true });

            return;
        }
        throw Object.assign(new Error('the evidence location is already taken'), { code: 'EEXIST' });
    }

    try {
        await rename(folder, destination);

        return;
    } catch (error) {
        if (errorCode(error) !== 'EXDEV') {
            throw error;
        }
    }

    const staging = path.join(storageRoot, INCOMING_DIR, path.basename(folder));

    try {
        await rm(staging, { force: true, recursive: true });
        await mkdir(path.dirname(staging), { recursive: true });
        await cp(folder, staging, { recursive: true });
        await rename(staging, destination);
    } catch (error) {
        await rm(staging, { force: true, recursive: true }).catch(() => undefined);
        throw error;
    }
    await rm(folder, { force: true, recursive: true });
}

/**
 * Moves a finalised evidence folder into the storage root, at `location`. Either the whole folder appears there or
 * nothing does: a failed attempt leaves nothing behind in the storage root, and the folder stays in the spool.
 *
 * @param {string} folder - The finalised folder in the spool, named after its consultation.
 * @param {string} storageRoot - The evidence storage root.
 * @param {string} location - Where in the storage root.
 * @returns {Promise<void>}
 */
export async function moveIntoStorage(folder: string, storageRoot: string, location: string): Promise<void> {
    const destination = path.join(storageRoot, location);

    await checkStorageRoot(storageRoot);

    // The patient's folder, when this attempt creates it.
    const created = await mkdir(path.dirname(destination), { recursive: true });

    try {
        await moveFolder(folder, storageRoot, destination);
    } catch (error) {
        if (created) {
            // Only when it is still empty: another consultation of the patient may have been stored in it since.
            await rmdir(created).catch(() => undefined);
        }
        throw error;
    }
}

/**
 * The evidence recording of one consultation.
 */
export class EvidenceRecording {
    /** The consultation's folder in the spool. */
    readonly folder: string;

    private readonly consultationId: string;
    private readonly raw: string;
    private readonly storageRoot: string;
    private fileCount = 0;

    /**
     * Names the consultation's spool folder. Call {@link open} to create it.
     *
     * @param {Object} options - Options.
     * @param {string} options.consultationId - The consultation.
     * @param {string} options.spoolDir - The spool.
     * @param {string} options.storageRoot - The evidence storage root.
     */
    constructor({ consultationId, spoolDir, storageRoot }: {
        consultationId: string;
        spoolDir: string;
        storageRoot: string;
    }) {
        this.consultationId = consultationId;
        this.folder = path.join(spoolDir, consultationId);
        this.raw = path.join(this.folder, RAW_DIR);
        this.storageRoot = storageRoot;
    }

    /**
     * Creates the spool folder.
     *
     * @returns {Promise<void>}
     */
    async open(): Promise<void> {
        await mkdir(this.raw, { recursive: true });
    }

    /**
     * Names the file of a new track: numbered in the order the tracks started, with the participant's endpoint and
     * the kind of track.
     *
     * @param {string} endpointId - The participant's endpoint.
     * @param {TrackKind} kind - Audio or video.
     * @returns {string}
     */
    newFile(endpointId: string, kind: TrackKind): string {
        this.fileCount += 1;

        // Endpoint ids come from the participants' clients; keep them to characters that are safe in a file name.
        return `${String(this.fileCount).padStart(2, '0')}-${endpointId.replace(/[^\w-]/g, '_')}-${kind}.webm`;
    }

    /**
     * Appends a chunk to a track's file.
     *
     * @param {string} file - The file.
     * @param {Buffer} data - The chunk.
     * @returns {Promise<void>}
     */
    append(file: string, data: Buffer): Promise<void> {
        return appendFile(path.join(this.raw, file), data);
    }

    /**
     * Finalises the folder in the spool: remuxes every file, then writes `timeline.json` and, last, `manifest.json`.
     *
     * @param {IEvidenceInput} input - The consultation.
     * @returns {Promise<void>}
     */
    async finalise(input: IEvidenceInput): Promise<void> {
        const files: IManifestFile[] = [];

        for (const track of input.tracks) {
            files.push(await this.finaliseFile(track));
        }

        await writeJson(path.join(this.folder, 'timeline.json'), {
            consultationId: input.consultationId,
            entries: input.timeline
        });
        await rm(this.raw, { force: true, recursive: true });

        // Last, and atomically: a folder with a manifest is finalised (readManifest).
        await writeJson(path.join(this.folder, `${MANIFEST}.tmp`), {
            consultationId: input.consultationId,
            hn: input.hn,
            room: input.room,
            consultationStart: input.consultationStart,
            part: input.part,
            awaiting: input.awaitingParts?.length ? input.awaitingParts : undefined,
            meetingId: input.meetingId,
            start: input.start,
            end: input.end,
            stopReason: input.stopReason,
            participants: input.participants,
            identities: input.identities,
            files,
            staffVisits: input.staffVisits,
            gaps: input.timeline.flatMap(e => e.type === 'gap' ? [ { end: e.end, start: e.start } ] : [])
        });
        await rename(path.join(this.folder, `${MANIFEST}.tmp`), path.join(this.folder, MANIFEST));
    }

    /**
     * Moves the finalised folder into the storage root.
     *
     * @param {string} location - Where in the storage root, from {@link evidenceLocation}.
     * @returns {Promise<void>}
     */
    store(location: string): Promise<void> {
        return storeFolder(this.folder, this.storageRoot, location);
    }

    /**
     * Remuxes one track's raw file with a stream copy, which gives it a duration and makes it seekable.
     *
     * @param {ITrack} track - The track.
     * @returns {Promise<IManifestFile>} The file's manifest entry.
     */
    private async finaliseFile(track: ITrack): Promise<IManifestFile> {
        const raw = path.join(this.raw, track.file);
        const final = path.join(this.folder, track.file);
        const entry = {
            endpointId: track.endpointId,
            kind: track.kind,
            name: track.file,
            start: track.start,
            stop: track.stop
        };

        if (!await sizeOf(raw)) {
            log.warn('no media was recorded for a track', { consultationId: this.consultationId, file: track.file });

            return { ...entry, bytes: 0, duration: null };
        }

        try {
            await execFileAsync('ffmpeg', [ '-hide_banner', '-loglevel', 'error', '-y', '-i', raw, '-c', 'copy', final ]);
        } catch (error) {
            // Keep the media as it was recorded rather than lose it.
            log.warn('could not remux a file; keeping it as recorded', {
                consultationId: this.consultationId,
                error: errorCode(error),
                file: track.file
            });
            await rm(final, { force: true });
            await rename(raw, final);
        }

        const codec = track.kind === 'video' ? await videoCodecOf(final) : undefined;

        return { ...entry, bytes: await sizeOf(final), ...codec ? { codec } : {}, duration: await durationOf(final) };
    }
}
