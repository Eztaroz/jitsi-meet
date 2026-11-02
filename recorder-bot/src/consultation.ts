/**
 * One consultation being recorded: the adapter between the in-page bot, real timers and the consultation lifecycle
 * module, which decides when the consultation stops. When the bot crashes or loses its connection while the
 * consultation runs, the consultation relaunches it into the same room and the same spool folder.
 */
import { randomUUID } from 'node:crypto';

import { type IBot, type PageEvent, launchBot } from './bot.ts';
import type { IConfig } from './config.ts';
import {
    type IConsultationLifecycle,
    type LifecycleCommand,
    type LifecycleEvent,
    type StopReason,
    type TimelineEntry,
    type Timer,
    createConsultationLifecycle
} from './consultationLifecycle.ts';
import { EvidenceRecording, evidenceLocation } from './evidence.ts';
import { participantIdentity } from './identity.ts';
import { errorCode, log } from './log.ts';
import { roomNameFromHn } from './roomName.ts';

export type ConsultationStatus =
    | 'starting'
    | 'waiting_for_participants'
    | 'recording'
    | 'finalising'
    | 'stored'
    | 'spooled'

    /** A station consultation whose patient never arrived: nothing was kept. */
    | 'discarded'
    | 'failed';

/** What the control API reports about a consultation. */
export interface IConsultationSnapshot {
    /** The room the bot is in: the patient's own room, or the station. */
    conferenceRoom: string;
    consultationId: string;

    error?: string;
    /** Where the evidence recording is, relative to the evidence storage root, once it is stored. */
    evidenceLocation?: string;

    hn: string;

    /** How many times the bot was relaunched after a crash or a lost connection. */
    relaunches: number;
    room: string;
    startedAt: string;
    status: ConsultationStatus;
    stopReason?: StopReason;
    stoppedAt?: string;
}

type EventInput = LifecycleEvent extends infer E ? E extends LifecycleEvent ? Omit<E, 'at'> : never : never;

/** How long to wait before relaunching a bot that crashed or lost its connection. */
const RELAUNCH_DELAY_MS = 2000;

const TERMINAL: ReadonlySet<ConsultationStatus> = new Set([ 'stored', 'spooled', 'discarded', 'failed' ]);
const RUNNING: ReadonlySet<ConsultationStatus> = new Set([ 'starting', 'waiting_for_participants', 'recording' ]);

/**
 * A consultation, from the request to record it until its evidence is handled.
 */
export class Consultation {
    readonly id = randomUUID();
    readonly hn: string;

    /** The patient's room, from their HN. It names where the evidence is kept. */
    readonly room: string;

    /** The room the bot joins: the same, or the station. */
    readonly conferenceRoom: string;

    /** The station's patient, for the consultation of one patient in a station (ADR 0006). */
    readonly patientId?: string;
    readonly startedAt = new Date();

    /** Resolves when the consultation has reached a final status. */
    readonly done: Promise<void>;

    private readonly config: IConfig;
    private readonly evidence: EvidenceRecording;
    private readonly lifecycle: IConsultationLifecycle;
    private readonly timeline: TimelineEntry[] = [];
    private readonly timers = new Map<Timer, ReturnType<typeof setTimeout>>();

    /** The file of each recorder of each launch of the bot, keyed by {@link recorderKey}. */
    private readonly files = new Map<string, string>();

    /** Interrupted bots still closing; their last chunks may still be arriving. */
    private readonly retiring: Promise<void>[] = [];

    /** Files a chunk could not be written to, so that each is logged once. */
    private readonly failedFiles = new Set<string>();
    private bot?: IBot;
    private botJoined = false;

    /** Counts the bot's launches, so that what an interrupted launch still reports is ignored. */
    private launches = 0;
    private relaunches = 0;

    /** Whether the bot is interrupted: it crashed or lost its connection, and has not resumed. */
    private interrupted = false;
    private relaunchTimer?: ReturnType<typeof setTimeout>;
    private error?: string;

    /** Why the bot could not be relaunched, when it could not. */
    private botFailure?: string;
    private evidenceLocation?: string;
    private meetingId?: string;
    private humanJoined = false;
    private status: ConsultationStatus = 'starting';
    private stopReason?: StopReason;
    private stoppedAt?: Date;
    private resolveDone: () => void = () => undefined;

    /**
     * Creates a consultation for an HN. Call {@link start} to launch its bot.
     *
     * @param {string} hn - The patient's HN.
     * @param {IConfig} config - Service settings.
     * @param {Object} station - Set for the consultation of one patient in a station.
     * @param {string} station.patientId - The patient's verified identity id.
     * @param {string} station.room - The station.
     */
    constructor(hn: string, config: IConfig, station?: { patientId: string; room: string; }) {
        this.hn = hn;
        this.room = roomNameFromHn(hn);
        this.conferenceRoom = station ? roomNameFromHn(station.room) : this.room;
        this.patientId = station?.patientId;
        this.config = config;
        this.lifecycle = createConsultationLifecycle({
            emptyRoomMs: config.emptyRoomGraceMs,
            firstJoinMs: config.firstJoinWaitMs,
            patientId: station?.patientId,
            patientWaitMs: config.patientWaitMs
        });
        this.evidence = new EvidenceRecording({
            consultationId: this.id,
            spoolDir: config.spoolDir,
            storageRoot: config.storageRoot
        });
        this.done = new Promise(resolve => {
            this.resolveDone = resolve;
        });
    }

    /**
     * Whether the consultation has not reached a final status yet.
     *
     * @returns {boolean}
     */
    isActive(): boolean {
        return !TERMINAL.has(this.status);
    }

    /**
     * Whether the consultation has not stopped yet: its bot is starting or in the room.
     *
     * @returns {boolean}
     */
    isRunning(): boolean {
        return RUNNING.has(this.status);
    }

    /**
     * Returns what the control API reports.
     *
     * @returns {IConsultationSnapshot}
     */
    snapshot(): IConsultationSnapshot {
        return {
            consultationId: this.id,
            error: this.error,
            conferenceRoom: this.conferenceRoom,
            evidenceLocation: this.evidenceLocation,
            hn: this.hn,
            relaunches: this.relaunches,
            room: this.room,
            startedAt: this.startedAt.toISOString(),
            status: this.status,
            stopReason: this.stopReason,
            stoppedAt: this.stoppedAt?.toISOString()
        };
    }

    /**
     * Creates the consultation's spool folder and launches the bot.
     *
     * @returns {void}
     */
    start() {
        log.info('consultation starting', { consultationId: this.id });
        this.evidence.open().then(() => this.launch(), error => {
            this.error = `spool_failed: ${errorCode(error)}`;
            log.error('could not create the consultation\'s spool folder', {
                consultationId: this.id,
                error: errorCode(error)
            });
            this.settle('failed');
        });
    }

    /**
     * Records that the evidence recording, left in the spool because the storage root was unavailable, has since been
     * moved into the storage root.
     *
     * @param {string} location - Where in the storage root.
     * @returns {void}
     */
    markStored(location: string) {
        if (this.status === 'spooled') {
            this.evidenceLocation = location;
            this.error = this.botFailure;
            this.status = this.storedStatus();
        }
    }

    /**
     * Stops the consultation before its time, because the hospital's system asked to. A station consultation whose
     * patient never arrived is discarded.
     *
     * @returns {Promise<void>}
     */
    requestStop(): Promise<void> {
        this.feed({ type: 'stop_requested' });

        return this.done;
    }

    /**
     * Stops the consultation because the service is shutting down.
     *
     * @returns {Promise<void>}
     */
    shutdown(): Promise<void> {
        this.feed({ type: 'shutdown' });

        return this.done;
    }

    /**
     * Launches a bot in a new browser. Its crash, or the loss of its connection, interrupts the consultation.
     *
     * @returns {void}
     */
    private launch() {
        const launch = ++this.launches;
        const isCurrent = () => launch === this.launches;

        launchBot(this.config, { consultationId: this.id, room: this.conferenceRoom }, {
            onChunk: (recorderId, data) => this.onChunk(recorderKey(launch, recorderId), data),
            onCrash: reason => {
                if (isCurrent()) {
                    this.interrupt(reason);
                }
            },
            onEvent: event => {
                if (isCurrent()) {
                    this.onPageEvent(event, launch);
                }
            }
        }).then(bot => {
            if (isCurrent() && this.isRunning()) {
                this.bot = bot;
            } else {
                // Interrupted, or stopped, while the browser was starting.
                this.retiring.push(bot.stop({ leave: true }));
            }
        }, error => {
            if (isCurrent()) {
                // By its code only: Playwright's messages quote what the page threw, which may name the room.
                this.interrupt(`launch_failed: ${errorCode(error)}`);
            }
        });
    }

    /**
     * Handles a bot that crashed or lost its connection while the consultation runs: records the interruption and
     * relaunches the bot, as long as relaunches are left. After that, the consultation stops with what it has.
     *
     * @param {string} reason - What happened to the bot.
     * @returns {void}
     */
    private interrupt(reason: string) {
        if (!this.isRunning()) {
            return;
        }
        log.warn('bot interrupted', { consultationId: this.id, error: reason, relaunches: this.relaunches });

        // From here on, the old bot is ignored. It may still deliver its last chunks while it closes.
        this.launches += 1;
        if (this.bot) {
            this.retiring.push(this.bot.stop({ leave: false }));
            this.bot = undefined;
        }
        if (!this.interrupted) {
            this.interrupted = true;
            this.feed({ type: 'bot_interrupted' });
        }

        if (this.relaunches >= this.config.maxRelaunches) {
            this.botFailure = `bot_failed: ${reason}`;
            this.error = this.botFailure;
            log.error('bot could not be relaunched; stopping with what was recorded', {
                consultationId: this.id,
                relaunches: this.relaunches
            });
            this.feed({ type: 'bot_failed' });

            return;
        }
        this.relaunches += 1;
        this.relaunchTimer = setTimeout(() => {
            if (this.isRunning()) {
                log.info('relaunching bot', { consultationId: this.id, relaunch: this.relaunches });
                this.launch();
            }
        }, RELAUNCH_DELAY_MS);
    }

    /**
     * Maps what the page reports to lifecycle events.
     *
     * @param {PageEvent} event - The page event.
     * @param {number} launch - Which launch of the bot reported it.
     * @returns {void}
     */
    private onPageEvent(event: PageEvent, launch: number) {
        switch (event.type) {
        case 'connected':
            log.info('bot connected', { consultationId: this.id });
            break;
        case 'waiting_for_host':
            // With Jicofo authentication, only an authenticated participant starts the room; the bot is not one.
            log.info('bot waiting for a host to start the room', { consultationId: this.id });
            if (this.status === 'starting') {
                this.status = 'waiting_for_participants';
            }
            if (this.interrupted) {
                // The room is not running, so nobody is in it: the relaunched bot knows that much.
                this.resume();
            }
            this.feed({ type: 'waiting_for_host' });
            break;
        case 'joined':
            this.botJoined = true;
            this.meetingId ??= event.meetingId;
            this.updateStatus();
            if (this.interrupted) {
                // lib-jitsi-meet reported who is in the room before this.
                this.resume();
            } else {
                log.info('bot joined', { consultationId: this.id });
                this.feed({ meetingId: event.meetingId, type: 'bot_joined' });
            }
            break;
        case 'meeting_id':
            this.meetingId ??= event.meetingId;
            break;
        case 'participant_joined':
            if (!event.hidden) {
                this.humanJoined = true;
                this.updateStatus();
            }
            this.feed({
                displayName: event.displayName,
                endpointId: event.endpointId,
                hidden: event.hidden,
                ...event.hidden
                    ? { role: 'unknown' }
                    : participantIdentity(event.identity, this.config.roleMarkers),
                type: 'participant_joined'
            });
            break;
        case 'participant_left':
            this.feed({ endpointId: event.endpointId, type: 'participant_left' });
            break;
        case 'track_started': {
            const file = this.evidence.newFile(event.endpointId, event.kind);

            this.files.set(recorderKey(launch, event.recorderId), file);
            this.feed({ endpointId: event.endpointId, file, kind: event.kind, type: 'track_started' });
            break;
        }
        case 'track_stopped': {
            const file = this.files.get(recorderKey(launch, event.recorderId));

            if (file) {
                this.feed({ file, type: 'track_stopped' });
            }
            break;
        }
        case 'video_resolution': {
            const file = this.files.get(recorderKey(launch, event.recorderId));

            if (file) {
                this.feed({ file, height: event.height, type: 'video_resolution', width: event.width });
            }
            break;
        }
        case 'recorder_error':
            log.warn('recorder error', {
                consultationId: this.id,
                error: event.error,
                file: this.files.get(recorderKey(launch, event.recorderId))
            });
            break;
        case 'room_destroyed':
            this.feed({ type: 'room_destroyed' });
            break;
        case 'kicked':
            this.feed({ type: 'kicked' });
            break;
        case 'connection_failed':
        case 'conference_failed':
        case 'disconnected':
            this.interrupt(`${event.type}: ${event.error}`);
            break;
        }
    }

    /**
     * Records that the relaunched bot is back.
     *
     * @returns {void}
     */
    private resume() {
        log.info('bot resumed', { consultationId: this.id, relaunches: this.relaunches });
        this.interrupted = false;
        this.feed({ type: 'bot_resumed' });
    }

    /**
     * Appends a recorder's chunk to its file in the spool.
     *
     * @param {string} key - The recorder, from {@link recorderKey}.
     * @param {Buffer} data - The chunk.
     * @returns {Promise<void>}
     */
    private async onChunk(key: string, data: Buffer) {
        const file = this.files.get(key);

        if (!file) {
            log.warn('chunk for an unknown recorder', { consultationId: this.id });

            return;
        }
        try {
            await this.evidence.append(file, data);
        } catch (error) {
            if (!this.failedFiles.has(file)) {
                this.failedFiles.add(file);
                log.error('could not write to a file in the spool', {
                    consultationId: this.id,
                    error: errorCode(error),
                    file
                });
            }
        }
    }

    /**
     * Moves a consultation that has not stopped to `waiting_for_participants` once the bot is in the room, and to
     * `recording` once a human has joined too. It stays `recording` while the room is empty within the grace.
     *
     * @returns {void}
     */
    private updateStatus() {
        if (this.status === 'starting' || this.status === 'waiting_for_participants') {
            if (this.botJoined) {
                this.status = this.humanJoined ? 'recording' : 'waiting_for_participants';
            }
        }
    }

    /**
     * Feeds an event, stamped with the current time, into the lifecycle module and runs its commands.
     *
     * @param {EventInput} event - The event.
     * @returns {void}
     */
    private feed(event: EventInput) {
        if (!this.isActive()) {
            return;
        }

        const { commands, entries } = this.lifecycle.handle({ ...event, at: new Date() } as LifecycleEvent);

        this.timeline.push(...entries);
        for (const entry of entries) {
            if (entry.type === 'stopped') {
                this.stoppedAt = entry.at;
            }
        }
        for (const command of commands) {
            this.run(command);
        }
    }

    /**
     * Runs one lifecycle command.
     *
     * @param {LifecycleCommand} command - The command.
     * @returns {void}
     */
    private run(command: LifecycleCommand) {
        switch (command.type) {
        case 'start_timer':
            clearTimeout(this.timers.get(command.timer));
            this.timers.set(command.timer, setTimeout(() => {
                this.timers.delete(command.timer);
                this.feed({ timer: command.timer, type: 'timer_fired' });
            }, command.ms));
            break;
        case 'cancel_timer':
            clearTimeout(this.timers.get(command.timer));
            this.timers.delete(command.timer);
            break;
        case 'stop':
            this.finish(command.reason);
            break;
        }
    }

    /**
     * Stops the bot after the lifecycle module decided the consultation is over, finalises the evidence recording
     * and moves it into the storage root. Whatever was recorded is finalised and stored, even when the bot failed.
     *
     * @param {StopReason} reason - Why.
     * @returns {Promise<void>}
     */
    private async finish(reason: StopReason) {
        this.status = 'finalising';
        this.stopReason = reason;
        log.info('consultation stopping', { consultationId: this.id, reason });

        // When the room is gone, leaving would only wait for a timeout.
        await Promise.all([
            this.bot?.stop({ leave: reason !== 'room_destroyed' && reason !== 'kicked' }),
            ...this.retiring
        ]);

        if (this.patientId !== undefined && !this.lifecycle.patientArrived()) {
            // The patient was never there, so there is nothing of them to keep, whatever the reason it stopped.
            try {
                await this.evidence.discard();
            } catch (error) {
                this.error = `discard_failed: ${errorCode(error)}`;
                log.error('could not discard the consultation\'s spool folder', {
                    consultationId: this.id,
                    error: errorCode(error)
                });
                this.settle('failed');

                return;
            }
            this.settle('discarded');

            return;
        }

        try {
            await this.evidence.finalise({
                conferenceRoom: this.conferenceRoom === this.room ? undefined : this.conferenceRoom,
                consultationId: this.id,
                end: this.stoppedAt ?? new Date(),
                hn: this.hn,
                identities: this.lifecycle.identities(),
                meetingId: this.meetingId,
                participants: this.lifecycle.participants(),
                room: this.room,
                staffVisits: this.lifecycle.staffVisits(),
                start: this.startedAt,
                stopReason: reason,
                timeline: this.timeline,
                tracks: this.lifecycle.tracks()
            });
        } catch (error) {
            this.error = `finalise_failed: ${errorCode(error)}`;
            log.error('could not finalise the evidence recording; it stays in the spool', {
                consultationId: this.id,
                error: errorCode(error)
            });
            this.settle('failed');

            return;
        }

        const location = evidenceLocation(this.room, this.startedAt);

        try {
            await this.evidence.store(location);
        } catch (error) {
            this.error = `store_failed: ${errorCode(error)}`;
            log.error('could not move the evidence recording to the storage root; it stays in the spool', {
                consultationId: this.id,
                error: errorCode(error)
            });
            this.settle('spooled');

            return;
        }
        this.evidenceLocation = location;
        log.info('evidence recording stored', { consultationId: this.id, files: this.lifecycle.tracks().length });
        this.settle(this.storedStatus());
    }

    /**
     * Returns the final status of a consultation whose evidence recording is stored. A consultation whose bot could
     * not be relaunched failed, even though what it recorded is stored.
     *
     * @returns {ConsultationStatus}
     */
    private storedStatus(): ConsultationStatus {
        return this.stopReason === 'bot_failed' ? 'failed' : 'stored';
    }

    /**
     * Records the final status.
     *
     * @param {ConsultationStatus} status - The final status.
     * @returns {void}
     */
    private settle(status: ConsultationStatus) {
        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }
        this.timers.clear();
        clearTimeout(this.relaunchTimer);
        this.status = status;
        log.info('consultation ended', { consultationId: this.id, status });
        this.resolveDone();
    }
}

/**
 * Names one recorder of one launch of the bot. Each launch numbers its recorders from the start.
 *
 * @param {number} launch - The launch.
 * @param {string} recorderId - The page's recorder.
 * @returns {string}
 */
function recorderKey(launch: number, recorderId: string): string {
    return `${launch}/${recorderId}`;
}
