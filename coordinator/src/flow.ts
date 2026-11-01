/**
 * Runs the patient-flow module: applies events one at a time, carries out the commands it returns, and feeds the
 * outcomes back as events. It is the only place with I/O and timers.
 */
import { randomUUID } from 'node:crypto';

import { type IAuditEntry, moveEntry, stageEntry } from './audit.ts';
import { signToken } from './jwt.ts';
import { log } from './log.ts';
import { nextMidnight } from './midnight.ts';
import {
    COUNTDOWN_MS,
    type Command,
    type FlowEvent,
    type IMove,
    type IState,
    type IStep,
    PREPARE_WAIT_MS,
    type Stage,
    queues,
    step
} from './patientFlow.ts';
import { type Prosody, ProsodyUnavailableError } from './prosody.ts';
import { type RecorderBot, RecorderBotUnavailableError } from './recorderBot.ts';
import { backendSafeRoomName } from './roomName.ts';
import { type ILayout, type IRoleMarkers, type IRoom, describeRooms } from './rooms.ts';
import type { Store } from './store.ts';
import { destinationClaims } from './tokens.ts';

/** The states of a move that is under way: it has no audit entry until it ends. */
const ACTIVE_MOVE = new Set([ 'counting_down', 'preparing' ]);
const POLL_MS = 1000;
const READY_POLL_MS = 500;
const TOKEN_LIFETIME_MS = 5 * 60_000;

/** The statuses by which the recorder bot is in the room, ready for the patient. */
const BOT_IN_ROOM = new Set([ 'waiting_for_participants', 'recording' ]);

export class Flow {
    private readonly _opts: {
        auditKey: string;
        layout: ILayout;
        prosody: Prosody;
        recorderBot: RecorderBot;
        retentionMs: number;
        retentionSweepMs: number;
        roleMarkers: IRoleMarkers;
        signingKey: { kid: string; privateKey: string; };
        store: Store;
        timeZone: string;
        token: { audience: string; issuer: string; subject: string; };
    };

    /** The moves whose end is in the audit log. */
    private readonly _audited = new Set<string>();

    /** Who asked for each move. */
    private readonly _issuers = new Map<string, string>();
    private _retention?: NodeJS.Timeout;

    /** The consultation each move started in a station, so that it can be stopped. */
    private readonly _stationConsultations = new Map<string, string>();
    private _midnight?: NodeJS.Timeout;
    private _poll?: NodeJS.Timeout;
    private _queue: Promise<unknown> = Promise.resolve();
    private _state: IState;

    /**
     * Creates the runner.
     *
     * @param {Object} opts - Its collaborators and settings.
     */
    constructor(opts: Flow['_opts']) {
        this._opts = opts;
        this._state = opts.store.load();
    }

    /**
     * The current state.
     *
     * @returns {IState}
     */
    get state(): IState {
        return this._state;
    }

    /**
     * Reads the rooms from Prosody, with the configured ones nobody is in.
     *
     * @returns {Promise<IRoom[]>}
     */
    async rooms(): Promise<IRoom[]> {
        return describeRooms(await this._opts.prosody.rooms(), this._opts.roleMarkers, this._opts.layout);
    }

    /**
     * Starts an encounter, or returns the open one. Nothing is saved unless the recorder bot accepted the room.
     *
     * @param {string} hn - The patient's HN.
     * @returns {Promise<IStep>}
     */
    startEncounter(hn: string): Promise<IStep> {
        return this._serial(async () => {
            const result = step(this._state, { at: new Date(), hn, type: 'start_encounter' });

            for (const command of result.commands) {
                if (command.type === 'record_room') {
                    await this._opts.recorderBot.recordRoom(command.hn);
                }
            }
            this._commit(result.state);

            return result;
        });
    }

    /**
     * Puts an encounter in a stage, forward or back; `done` closes it.
     *
     * @param {string} encounterId - The encounter.
     * @param {Stage} stage - The stage.
     * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
     * @returns {Promise<IStep>}
     */
    changeStage(encounterId: string, stage: Stage, issuer: string): Promise<IStep> {
        return this._serial(async () => {
            const at = new Date();
            const from = this._state.encounters.find(e => e.id === encounterId)?.stage;
            const result = step(this._state, { at, encounterId, stage, type: 'change_stage' });

            this._commit(result.state);
            this._audit(stageEntry({
                at, encounterId, from, issuer, outcome: result.refused ? 'refused' : 'ok', reason: result.refused, to: stage
            }));

            return result;
        });
    }

    /**
     * The newest audit entries.
     *
     * @param {number} limit - How many.
     * @returns {IAuditEntry[]}
     */
    audit(limit: number): IAuditEntry[] {
        return this._opts.store.audit(limit);
    }

    /**
     * The queues of the stages: the open encounters in each, the longest-waiting first.
     *
     * @returns {Queues}
     */
    queues() {
        return queues(this._state, new Date());
    }

    /**
     * Closes the day's encounters at every midnight of the configured time zone, from now on.
     *
     * @returns {void}
     */
    startDayEnds(): void {
        const arm = () => {
            const delay = nextMidnight(new Date(), this._opts.timeZone).getTime() - Date.now();

            this._midnight = setTimeout(() => {
                this._serial(async () => this._commit(step(this._state, { at: new Date(), type: 'close_day' }).state))
                    .catch(error => log.error('could not close the day', { error: (error as Error).name }))
                    .finally(arm);
            }, delay);
            this._midnight.unref();
        };

        arm();
    }

    /**
     * Asks to move a participant.
     *
     * @param {Object} request - Who to move, from which room to which.
     * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
     * @returns {Promise<IMove>}
     */
    requestMove(request: { endpointId: string; fromRoom: string; toRoom: string; }, issuer: string): Promise<IMove> {
        return this._serial(async () => {
            const rooms = await this.rooms();
            const named = (name: string) => rooms.find(r => backendSafeRoomName(r.name) === backendSafeRoomName(name))
                ?.name ?? name;
            const moveId = randomUUID();

            this._issuers.set(moveId, issuer);

            const result = await this._apply({
                at: new Date(),
                endpointId: request.endpointId,
                fromRoom: named(request.fromRoom),
                rooms,
                toRoom: named(request.toRoom),
                type: 'request_move'
            }, rooms, () => moveId);

            this._ensurePolling();

            return result.move as IMove;
        });
    }

    /**
     * Stops polling.
     *
     * @returns {void}
     */
    stop(): void {
        clearInterval(this._retention);
        clearTimeout(this._midnight);
        clearInterval(this._poll);
        this._poll = undefined;
    }

    /**
     * Applies an event and carries out its commands.
     *
     * @param {FlowEvent} event - The event.
     * @param {IRoom[]} rooms - The rooms at the time, for the commands that need the participant's identity.
     * @param {Function} newId - Makes the opaque id of a new move.
     * @returns {Promise<IStep>}
     */
    private async _apply(event: FlowEvent, rooms: IRoom[], newId?: () => string): Promise<IStep> {
        const result = step(this._state, event, newId);

        this._commit(result.state);
        for (const command of result.commands) {
            await this._run(command, rooms);
        }

        return result;
    }

    /**
     * Records a new state.
     *
     * @param {IState} state - The state.
     * @returns {void}
     */
    private _commit(state: IState): void {
        if (state !== this._state) {
            this._opts.store.save(state);
            this._state = state;
            this._auditEndedMoves();
        }
    }

    /**
     * Writes the audit entry of every move that has ended and has none yet.
     *
     * @returns {void}
     */
    private _auditEndedMoves(): void {
        for (const move of this._state.moves) {
            if (!ACTIVE_MOVE.has(move.state) && !this._audited.has(move.id)) {
                this._audited.add(move.id);
                this._audit(moveEntry(move, {
                    at: new Date(),
                    issuer: this._issuers.get(move.id) ?? 'system',
                    key: this._opts.auditKey,
                    layout: this._opts.layout
                }));
                this._issuers.delete(move.id);
            }
        }
    }

    /**
     * Writes an audit entry.
     *
     * @param {IAuditEntry} entry - The entry.
     * @returns {void}
     */
    private _audit(entry: IAuditEntry): void {
        try {
            this._opts.store.addAudit(entry);
        } catch (error) {
            log.error('could not write an audit entry', { error: (error as Error).name });
        }
    }

    /**
     * Deletes the encounters and audit entries older than the retention period, now and then.
     *
     * @returns {void}
     */
    startRetention(): void {
        const sweep = () => this._serial(async () => {
            const cutoff = new Date(Date.now() - this._opts.retentionMs);
            const removed = this._opts.store.sweep(cutoff);

            this._state = {
                ...this._state,
                encounters: this._state.encounters.filter(e => e.startedAt >= cutoff),
                moves: this._state.moves.filter(m => m.startedAt >= cutoff)
            };
            if (removed.audit || removed.encounters) {
                log.info('retention sweep', removed);
            }
        }).catch(error => log.error('the retention sweep failed', { error: (error as Error).name }));

        sweep();
        this._retention = setInterval(sweep, this._opts.retentionSweepMs);
        this._retention.unref();
    }

    /**
     * Carries out one command.
     *
     * @param {Command} command - The command.
     * @param {IRoom[]} rooms - The rooms at the time.
     * @returns {Promise<void>}
     */
    private async _run(command: Command, rooms: IRoom[]): Promise<void> {
        switch (command.type) {
        case 'record_room':
            await this._opts.recorderBot.recordRoom(command.hn);
            break;
        case 'start_timer':
            setTimeout(() => {
                this._serial(() => this._apply({
                    at: new Date(), moveId: command.moveId, timer: command.timer, type: 'timer_fired'
                }, [])).catch(error => log.error('a timer failed', { error: (error as Error).name }));
            }, command.afterMs).unref();
            break;
        case 'prepare_destination':
            this._prepareDestination(command.moveId, command.hn, command.station);
            break;
        case 'stop_station_consultation': {
            const consultationId = this._stationConsultations.get(command.moveId);

            this._stationConsultations.delete(command.moveId);
            if (consultationId) {
                this._opts.recorderBot.stop(consultationId).catch(error => log.warn('could not stop a station consultation', {
                    error: error instanceof RecorderBotUnavailableError ? error.code : 'unknown'
                }));
            }
            break;
        }
        case 'send_move':
            await this._sendMove(command, rooms);
            break;
        }
    }

    /**
     * Sends the participant the command to move. When that fails, the move fails.
     *
     * @param {Object} command - The `send_move` command.
     * @param {IRoom[]} rooms - The rooms at the time.
     * @returns {Promise<void>}
     */
    private async _sendMove(command: Extract<Command, { type: 'send_move'; }>, rooms: IRoom[]): Promise<void> {
        const occupant = rooms.find(r => r.name === command.room)?.occupants
            .find(o => o.endpointId === command.endpointId);
        const token = signToken({
            claims: destinationClaims({
                ...this._opts.token,
                identity: occupant?.identity ?? {},
                lifetimeMs: TOKEN_LIFETIME_MS,
                markers: this._opts.roleMarkers,
                now: new Date(),
                role: occupant?.role ?? 'unknown',
                room: command.destination
            }),
            ...this._opts.signingKey
        });

        try {
            await this._opts.prosody.sendMove({
                endpointId: command.endpointId,
                move: {
                    countdownSeconds: COUNTDOWN_MS / 1000,
                    destination: command.destination,
                    moveId: command.moveId,
                    token,
                    type: 'coordinator_move'
                },
                room: backendSafeRoomName(command.room)
            });
        } catch (error) {
            log.warn('could not send a move', { error: error instanceof ProsodyUnavailableError ? error.code : 'unknown' });
            this._commit(step(this._state, {
                at: new Date(), moveId: command.moveId, reason: 'could_not_send_move', type: 'destination_failed'
            }).state);
            throw error;
        }
    }

    /**
     * Opens a patient's own room by asking the recorder bot to record it, then reports when the bot is in it, or
     * why it cannot be. It runs on in the background; the module's timer ends the wait.
     *
     * @param {string} moveId - The move.
     * @param {string} hn - The patient's HN, which is the room, or whose time in a station is recorded.
     * @param {Object} station - Set to record one patient's time in a station instead.
     * @param {string} station.patientId - The patient's verified identity id.
     * @param {string} station.room - The station.
     * @returns {void}
     */
    private _prepareDestination(moveId: string, hn: string, station?: { patientId: string; room: string; }): void {
        const report = (event: FlowEvent) => this._serial(async () => {
            const rooms = event.type === 'destination_ready' ? await this.rooms().catch(() => []) : [];

            await this._apply(event, rooms);
        }).catch(error => log.error('could not report on a destination', { error: (error as Error).name }));

        (async () => {
            const deadline = Date.now() + PREPARE_WAIT_MS;
            // The room's name has lost the HN's case; the encounter kept the HN as the hospital wrote it.
            const known = this._state.encounters.find(e => backendSafeRoomName(e.hn) === backendSafeRoomName(hn))?.hn;
            const consultationId = await this._opts.recorderBot.recordRoom(station ? known ?? hn : hn, station);

            if (station) {
                this._stationConsultations.set(moveId, consultationId);
                if (!this._state.moves.some(m => m.id === moveId && m.state === 'preparing')) {
                    // The move ended while the recorder bot was answering: nobody is coming.
                    this._stationConsultations.delete(moveId);
                    await this._opts.recorderBot.stop(consultationId);

                    return;
                }
            }

            while (Date.now() < deadline) {
                if (!this._state.moves.some(m => m.id === moveId && m.state === 'preparing')) {
                    return;
                }
                if (BOT_IN_ROOM.has(await this._opts.recorderBot.status(consultationId))) {
                    await report({ at: new Date(), moveId, type: 'destination_ready' });

                    return;
                }
                await new Promise(resolve => setTimeout(resolve, READY_POLL_MS));
            }
        })().catch(async error => {
            const reason = error instanceof RecorderBotUnavailableError && error.code === 'at_capacity'
                ? 'recorder_bot_at_capacity'
                : 'recorder_bot_unreachable';

            log.warn('could not open a destination', { error: error instanceof RecorderBotUnavailableError ? error.code : 'unknown' });
            await report({ at: new Date(), moveId, reason, type: 'destination_failed' });
        });
    }

    /**
     * Polls the rooms while a move is under way, so that arrivals are noticed.
     *
     * @returns {void}
     */
    private _ensurePolling(): void {
        if (this._poll) {
            return;
        }
        this._poll = setInterval(() => {
            if (!this._state.moves.some(m => m.state === 'counting_down')) {
                if (!this._state.moves.some(m => m.state === 'preparing')) {
                    this.stop();
                }

                return;
            }
            this._serial(async () => {
                const rooms = await this.rooms();

                await this._apply({ at: new Date(), rooms, type: 'rooms_snapshot' }, rooms);
            }).catch(() => undefined);
        }, POLL_MS);
        this._poll.unref();
    }

    /**
     * Runs a task after the ones before it, so that events are applied one at a time.
     *
     * @param {Function} task - The task.
     * @returns {Promise<T>}
     */
    private _serial<T>(task: () => Promise<T>): Promise<T> {
        const answer = this._queue.then(task, task);

        this._queue = answer.catch(() => undefined);

        return answer;
    }
}
