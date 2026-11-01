/**
 * Runs the patient-flow module: applies events one at a time, carries out the commands it returns, and feeds the
 * outcomes back as events. It is the only place with I/O and timers.
 */
import { signToken } from './jwt.ts';
import { log } from './log.ts';
import { COUNTDOWN_MS, type Command, type FlowEvent, type IMove, type IRoomView, type IState, type IStep, step } from './patientFlow.ts';
import { type Prosody, ProsodyUnavailableError } from './prosody.ts';
import type { RecorderBot } from './recorderBot.ts';
import { type IRoleMarkers, type IRoom, describeRooms } from './rooms.ts';
import type { Store } from './store.ts';
import { backendSafeRoomName, destinationClaims } from './tokens.ts';

const POLL_MS = 1000;
const TOKEN_LIFETIME_MS = 5 * 60_000;

export class Flow {
    private readonly _opts: {
        prosody: Prosody;
        recorderBot: RecorderBot;
        roleMarkers: IRoleMarkers;
        signingKey: { kid: string; privateKey: string; };
        store: Store;
        token: { audience: string; issuer: string; subject: string; };
    };

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
     * Reads the rooms from Prosody.
     *
     * @returns {Promise<IRoom[]>}
     */
    async rooms(): Promise<IRoom[]> {
        return describeRooms(await this._opts.prosody.rooms(), this._opts.roleMarkers);
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
     * Asks to move a participant.
     *
     * @param {Object} request - Who to move, from which room to which.
     * @returns {Promise<IMove>}
     */
    requestMove(request: { endpointId: string; fromRoom: string; toRoom: string; }): Promise<IMove> {
        return this._serial(async () => {
            const rooms = await this.rooms();
            const result = await this._apply({ at: new Date(), ...request, rooms, type: 'request_move' }, rooms);

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
        clearInterval(this._poll);
        this._poll = undefined;
    }

    /**
     * Applies an event and carries out its commands.
     *
     * @param {FlowEvent} event - The event.
     * @param {IRoom[]} rooms - The rooms at the time, for the commands that need the participant's identity.
     * @returns {Promise<IStep>}
     */
    private async _apply(event: FlowEvent, rooms: IRoom[]): Promise<IStep> {
        const result = step(this._state, event);

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
        }
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
        case 'send_move': {
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
                    move: { countdownSeconds: COUNTDOWN_MS / 1000, destination: command.destination, moveId: command.moveId, token, type: 'coordinator_move' },
                    room: backendSafeRoomName(command.room)
                });
            } catch (error) {
                log.warn('could not send a move', { error: error instanceof ProsodyUnavailableError ? error.code : 'unknown' });
                throw error;
            }
            break;
        }
        }
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
                this.stop();

                return;
            }
            this._serial(async () => {
                const rooms = await this.rooms();

                await this._apply({ at: new Date(), rooms: rooms as IRoomView[], type: 'rooms_snapshot' }, rooms);
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
