/**
 * One consultation being recorded: the adapter between the in-page bot, real timers and the consultation lifecycle
 * module, which decides when the consultation stops.
 */
import { randomUUID } from 'node:crypto';

import { type IBot, type PageEvent, launchBot } from './bot.ts';
import type { IConfig } from './config.ts';
import {
    type IConsultationLifecycle,
    type LifecycleCommand,
    type LifecycleEvent,
    type StopReason,
    type Timer,
    createConsultationLifecycle
} from './consultationLifecycle.ts';
import { log } from './log.ts';
import { roomNameFromHn } from './roomName.ts';

export type ConsultationStatus =
    | 'starting'
    | 'waiting_for_participants'
    | 'recording'
    | 'finalising'
    | 'stored'
    | 'spooled'
    | 'failed';

/** What the control API reports about a consultation. */
export interface IConsultationSnapshot {
    consultationId: string;
    error?: string;
    hn: string;
    room: string;
    startedAt: string;
    status: ConsultationStatus;
    stopReason?: StopReason;
    stoppedAt?: string;
}

type EventInput = LifecycleEvent extends infer E ? E extends LifecycleEvent ? Omit<E, 'at'> : never : never;

const TERMINAL: ReadonlySet<ConsultationStatus> = new Set([ 'stored', 'spooled', 'failed' ]);

/**
 * A consultation, from the request to record it until its evidence is handled.
 */
export class Consultation {
    readonly id = randomUUID();
    readonly hn: string;
    readonly room: string;
    readonly startedAt = new Date();

    /** Resolves when the consultation has reached a final status. */
    readonly done: Promise<void>;

    private readonly config: IConfig;
    private readonly lifecycle: IConsultationLifecycle;
    private readonly timers = new Map<Timer, ReturnType<typeof setTimeout>>();
    private bot?: IBot;
    private error?: string;
    private status: ConsultationStatus = 'starting';
    private stopReason?: StopReason;
    private stoppedAt?: Date;
    private resolveDone: () => void = () => undefined;

    /**
     * Creates a consultation for an HN. Call {@link start} to launch its bot.
     *
     * @param {string} hn - The patient's HN.
     * @param {IConfig} config - Service settings.
     */
    constructor(hn: string, config: IConfig) {
        this.hn = hn;
        this.room = roomNameFromHn(hn);
        this.config = config;
        this.lifecycle = createConsultationLifecycle();
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
     * Returns what the control API reports.
     *
     * @returns {IConsultationSnapshot}
     */
    snapshot(): IConsultationSnapshot {
        return {
            consultationId: this.id,
            error: this.error,
            hn: this.hn,
            room: this.room,
            startedAt: this.startedAt.toISOString(),
            status: this.status,
            stopReason: this.stopReason,
            stoppedAt: this.stoppedAt?.toISOString()
        };
    }

    /**
     * Launches the bot. Failures end the consultation with status `failed`.
     *
     * @returns {void}
     */
    start() {
        log.info('consultation starting', { consultationId: this.id });
        launchBot(this.config, { consultationId: this.id, room: this.room }, {
            onCrash: reason => this.fail(reason),
            onEvent: event => this.onPageEvent(event)
        }).then(bot => {
            this.bot = bot;
            if (!this.isActive() || this.status === 'finalising') {
                // It ended while the browser was starting.
                bot.stop({ leave: true });
            }
        }, error => this.fail(`launch_failed: ${error instanceof Error ? error.message : String(error)}`));
    }

    /**
     * Stops the consultation because the service is shutting down.
     *
     * @returns {Promise<void>}
     */
    shutdown(): Promise<void> {
        this.send({ type: 'shutdown' });

        return this.done;
    }

    /**
     * Maps what the page reports to lifecycle events.
     *
     * @param {PageEvent} event - The page event.
     * @returns {void}
     */
    private onPageEvent(event: PageEvent) {
        switch (event.type) {
        case 'connected':
            log.info('bot connected', { consultationId: this.id });
            break;
        case 'joined':
            log.info('bot joined', { consultationId: this.id });
            if (this.status === 'starting') {
                this.status = 'recording';
            }
            this.send({ meetingId: event.meetingId, type: 'bot_joined' });
            break;
        case 'participant_joined':
            this.send({
                displayName: event.displayName,
                endpointId: event.endpointId,
                hidden: event.hidden,
                role: 'unknown',
                type: 'participant_joined'
            });
            break;
        case 'participant_left':
            this.send({ endpointId: event.endpointId, type: 'participant_left' });
            break;
        case 'room_destroyed':
            this.send({ type: 'room_destroyed' });
            break;
        case 'kicked':
            this.send({ type: 'kicked' });
            break;
        case 'connection_failed':
        case 'conference_failed':
        case 'disconnected':
            this.fail(`${event.type}: ${event.error}`);
            break;
        }
    }

    /**
     * Feeds an event, stamped with the current time, into the lifecycle module and runs its commands.
     *
     * @param {EventInput} event - The event.
     * @returns {void}
     */
    private send(event: EventInput) {
        if (!this.isActive()) {
            return;
        }

        const { commands, entries } = this.lifecycle.handle({ ...event, at: new Date() } as LifecycleEvent);

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
                this.send({ timer: command.timer, type: 'timer_fired' });
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
     * Stops the bot after the lifecycle module decided the consultation is over.
     *
     * @param {StopReason} reason - Why.
     * @returns {Promise<void>}
     */
    private async finish(reason: StopReason) {
        this.status = 'finalising';
        this.stopReason = reason;
        log.info('consultation stopping', { consultationId: this.id, reason });

        // When the room is gone, leaving would only wait for a timeout.
        await this.bot?.stop({ leave: reason !== 'room_destroyed' && reason !== 'kicked' });

        this.settle('stored');
    }

    /**
     * Ends the consultation because its bot failed.
     *
     * @param {string} error - What failed.
     * @returns {void}
     */
    private fail(error: string) {
        if (!this.isActive() || this.status === 'finalising') {
            return;
        }
        log.error('consultation failed', { consultationId: this.id, error });
        this.error = error;
        this.stoppedAt = new Date();
        this.bot?.stop({ leave: false });
        this.settle('failed');
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
        this.status = status;
        log.info('consultation ended', { consultationId: this.id, status });
        this.resolveDone();
    }
}
