/**
 * The side effect of a move: sending the staff member the command to move, with a destination token. The coordinator
 * service decides when; this module does the talking to Prosody.
 */
import { signToken } from './jwt.ts';
import { log } from './log.ts';
import { type Prosody, ProsodyUnavailableError } from './prosody.ts';
import { backendSafeRoomName } from './roomName.ts';
import type { IRoleMarkers, IRoom } from './rooms.ts';
import { COUNTDOWN_MS, type Command } from './rules.ts';
import { destinationClaims } from './tokens.ts';

const TOKEN_LIFETIME_MS = 5 * 60_000;

/** What the move effects need from the service that owns the state. */
export interface IMoveEffectsHooks {

    /** Fails a move whose command could not be sent. */
    failSend: (moveId: string) => void;
}

export interface IMoveEffectsOptions {
    prosody: Prosody;
    roleMarkers: IRoleMarkers;
    signingKey: { kid: string; privateKey: string; };
    token: { audience: string; issuer: string; subject: string; };
}

export class MoveEffects {
    private readonly _hooks: IMoveEffectsHooks;
    private readonly _opts: IMoveEffectsOptions;

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
}
