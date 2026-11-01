/**
 * The side effects of a move: preparing its destination with the recorder bot and sending the participant the command
 * to move. The coordinator service decides when; this module does the talking to the recorder bot and Prosody.
 */
import { signToken } from './jwt.ts';
import { log } from './log.ts';
import { type Prosody, ProsodyUnavailableError } from './prosody.ts';
import { type RecorderBot, RecorderBotUnavailableError } from './recorderBot.ts';
import { backendSafeRoomName } from './roomName.ts';
import type { IRoleMarkers, IRoom } from './rooms.ts';
import { COUNTDOWN_MS, type Command, type IStationConsultation, PREPARE_WAIT_MS, type RulesEvent } from './rules.ts';
import { destinationClaims } from './tokens.ts';

const READY_POLL_MS = 500;
const TOKEN_LIFETIME_MS = 5 * 60_000;

/** The statuses by which the recorder bot is in the room, ready for the patient. */
const BOT_IN_ROOM = new Set([ 'waiting_for_participants', 'recording' ]);

/** What the move effects need from the service that owns the state. */
export interface IMoveEffectsHooks {

    /** The consultation started in a station for a move, or `undefined` once it is no longer to be stopped. */
    consultation: (moveId: string, consultationId: string | undefined) => void;

    /** Fails a move whose command could not be sent. */
    failSend: (moveId: string) => void;

    /** Whether the move is still preparing its destination. */
    isPreparing: (moveId: string) => boolean;

    /** The HN as the hospital wrote it, for a room name that has lost its case. */
    knownHn: (hn: string) => string | undefined;

    /** Feeds an outcome back to the service as an event, after the ones before it. */
    report: (event: RulesEvent) => Promise<void>;
}

export interface IMoveEffectsOptions {
    prosody: Prosody;
    recorderBot: RecorderBot;
    roleMarkers: IRoleMarkers;
    signingKey: { kid: string; privateKey: string; };
    token: { audience: string; issuer: string; subject: string; };
}

export class MoveEffects {
    private readonly _hooks: IMoveEffectsHooks;
    private readonly _opts: IMoveEffectsOptions;

    /** The consultation each move started in a station, so that it can be stopped. */
    private readonly _stationConsultations = new Map<string, string>();

    /**
     * Creates the move effects.
     *
     * @param {IMoveEffectsOptions} opts - Its collaborators and settings.
     * @param {IMoveEffectsHooks} hooks - What it needs from the service.
     */
    constructor(opts: IMoveEffectsOptions, hooks: IMoveEffectsHooks) {
        this._opts = opts;
        this._hooks = hooks;
    }

    /**
     * Takes back the consultation a move started in a station before a restart, so that it can still be stopped.
     *
     * @param {string} moveId - The move.
     * @param {string} consultationId - The consultation.
     * @returns {void}
     */
    restore(moveId: string, consultationId: string): void {
        this._stationConsultations.set(moveId, consultationId);
    }

    /**
     * Stops the consultation started in a station for a move that did not bring the patient. Nothing is kept.
     *
     * @param {string} moveId - The move.
     * @returns {void}
     */
    stopStationConsultation(moveId: string): void {
        const consultationId = this._stationConsultations.get(moveId);

        this._stationConsultations.delete(moveId);
        this._hooks.consultation(moveId, undefined);
        if (consultationId) {
            this._opts.recorderBot.stop(consultationId).catch(error => log.warn('could not stop a station consultation', {
                error: error instanceof RecorderBotUnavailableError ? error.code : 'unknown'
            }));
        }
    }

    /**
     * Sends the participant the command to move. When that fails, the move fails.
     *
     * @param {Object} command - The `send_move` command.
     * @param {IRoom[]} rooms - The rooms at the time.
     * @returns {Promise<void>}
     */
    async sendMove(command: Extract<Command, { type: 'send_move'; }>, rooms: IRoom[]): Promise<void> {
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
            this._hooks.failSend(command.moveId);
            throw error;
        }
    }

    /**
     * Opens a patient's own room by asking the recorder bot to record it, then reports when the bot is in it, or
     * why it cannot be. It runs on in the background; the rules module's timer ends the wait.
     *
     * @param {string} moveId - The move.
     * @param {string} hn - The patient's HN, which is the room, or whose time in a station is recorded.
     * @param {IStationConsultation} station - Set to record one patient's time in a station instead.
     * @returns {void}
     */
    prepareDestination(moveId: string, hn: string, station?: IStationConsultation): void {
        const report = (event: RulesEvent) => this._hooks.report(event)
            .catch(error => log.error('could not report on a destination', { error: (error as Error).name }));

        (async () => {
            const deadline = Date.now() + PREPARE_WAIT_MS;
            // The room's name has lost the HN's case; the encounter kept the HN as the hospital wrote it.
            const known = this._hooks.knownHn(hn);
            const consultationId = await this._opts.recorderBot.recordRoom(station ? known ?? hn : hn, station);

            if (station) {
                this._stationConsultations.set(moveId, consultationId);
                this._hooks.consultation(moveId, consultationId);
                if (!this._hooks.isPreparing(moveId)) {
                    // The move ended while the recorder bot was answering: nobody is coming.
                    this._stationConsultations.delete(moveId);
                    this._hooks.consultation(moveId, undefined);
                    await this._opts.recorderBot.stop(consultationId);

                    return;
                }
            }

            while (Date.now() < deadline) {
                if (!this._hooks.isPreparing(moveId)) {
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
}
