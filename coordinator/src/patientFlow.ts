/**
 * The patient-flow module: owns encounters and, in later slices, stages, queues, the room rules and moves.
 *
 * It is pure. It takes timestamped events and returns the new state, the commands the caller must carry out and the
 * result for the caller's request. It does no I/O and has no timers of its own.
 */
import { randomUUID } from 'node:crypto';

export type Stage = 'waiting' | 'intake' | 'examination' | 'aftercare' | 'done';

export interface IEncounter {

    hn: string;
    /** Opaque; never derived from the HN. */
    id: string;
    stage: Stage;
    startedAt: Date;
}

/** How long the moved participant's notice counts down before their client leaves, in milliseconds. */
export const COUNTDOWN_MS = 5000;

/** How long a participant has, after the countdown, to appear in the destination, in milliseconds. */
export const ARRIVAL_WAIT_MS = 30_000;

export type MoveState = 'cancelled' | 'counting_down' | 'done' | 'failed' | 'refused';

export interface IMove {
    destination: string;
    endpointId: string;

    id: string;
    /** The verified identity of the participant, by which their arrival is recognised. */
    identityId?: string;
    origin: string;
    reason?: string;
    startedAt: Date;
    state: MoveState;
}

export interface IState {
    encounters: IEncounter[];
    moves: IMove[];
}

/** A room as the rooms module describes it; only what the rules need. */
export interface IRoomView {
    name: string;
    occupants: {

        /** The id of the move this occupant says they cancel. */
        cancelledMove?: string;
        endpointId: string;
        identity?: { id?: string; };
        role: 'hidden' | 'patient' | 'staff' | 'unknown';
    }[];
}

export type FlowEvent = { at: Date; } & (
    | { hn: string; type: 'start_encounter'; }
    | { endpointId: string; fromRoom: string; rooms: IRoomView[]; toRoom: string; type: 'request_move'; }
    | { rooms: IRoomView[]; type: 'rooms_snapshot'; }
    | { moveId: string; timer: 'move_arrival'; type: 'timer_fired'; }
);

export type Command =
    | { hn: string; type: 'record_room'; }
    | { destination: string; endpointId: string; moveId: string; room: string; type: 'send_move'; }
    | { afterMs: number; moveId: string; timer: 'move_arrival'; type: 'start_timer'; };

export interface IStartResult extends IEncounter {

    /** False when the HN already had an open encounter. */
    created: boolean;
}

export interface IStep {
    commands: Command[];

    /** The encounter a start request returns. */
    encounter?: IStartResult;

    /** The move a move request returns, refused or not. */
    move?: IMove;
    state: IState;
}

/**
 * Returns the state of a service with no encounters.
 *
 * @returns {IState}
 */
export function initialState(): IState {
    return { encounters: [], moves: [] };
}

/**
 * Starts an encounter, or returns the open one.
 *
 * @param {IState} state - The current state.
 * @param {string} hn - The patient's HN.
 * @param {Date} at - When.
 * @param {() => string} newId - Makes an opaque id.
 * @returns {IStep}
 */
function startEncounter(state: IState, hn: string, at: Date, newId: () => string): IStep {
    const open = state.encounters.find(e => e.hn === hn && e.stage !== 'done');

    if (open) {
        return { commands: [], encounter: { ...open, created: false }, state };
    }

    const encounter: IEncounter = { hn, id: newId(), stage: 'waiting', startedAt: at };

    return {
        commands: [ { hn, type: 'record_room' } ],
        encounter: { ...encounter, created: true },
        state: { ...state, encounters: [ ...state.encounters, encounter ] }
    };
}

/**
 * Starts a move, or refuses it.
 *
 * @param {IState} state - The current state.
 * @param {FlowEvent} event - The request.
 * @param {() => string} newId - Makes an opaque id.
 * @returns {IStep}
 */
function requestMove(state: IState, event: FlowEvent & { type: 'request_move'; }, newId: () => string): IStep {
    const occupant = event.rooms.find(r => r.name === event.fromRoom)?.occupants
        .find(o => o.endpointId === event.endpointId);
    const base = {
        destination: event.toRoom,
        endpointId: event.endpointId,
        id: newId(),
        identityId: occupant?.identity?.id,
        origin: event.fromRoom,
        startedAt: event.at
    };
    let reason: string | undefined;

    if (!occupant) {
        reason = 'participant_not_found';
    } else if (occupant.role === 'hidden') {
        reason = 'participant_not_movable';
    } else if (occupant.role !== 'staff') {
        reason = 'only_staff_can_be_moved';
    } else if (!event.rooms.some(r => r.name === event.toRoom)) {
        reason = 'destination_not_open';
    } else if (state.moves.some(m => m.state === 'counting_down'
            && (m.identityId !== undefined && m.identityId === base.identityId
                || m.origin === base.origin && m.endpointId === base.endpointId))) {
        reason = 'already_being_moved';
    }

    if (reason) {
        const refused: IMove = { ...base, reason, state: 'refused' };

        return { commands: [], move: refused, state: { ...state, moves: [ ...state.moves, refused ] } };
    }

    const move: IMove = { ...base, state: 'counting_down' };

    return {
        commands: [
            { destination: event.toRoom, endpointId: event.endpointId, moveId: move.id, room: event.fromRoom, type: 'send_move' },
            { afterMs: COUNTDOWN_MS + ARRIVAL_WAIT_MS, moveId: move.id, timer: 'move_arrival', type: 'start_timer' }
        ],
        move,
        state: { ...state, moves: [ ...state.moves, move ] }
    };
}

/**
 * Applies one event.
 *
 * @param {IState} state - The current state.
 * @param {FlowEvent} event - The event.
 * @param {() => string} newId - Makes an opaque id; replaceable by callers that need determinism.
 * @returns {IStep}
 */
export function step(state: IState, event: FlowEvent, newId: () => string = randomUUID): IStep {
    switch (event.type) {
    case 'start_encounter':
        return startEncounter(state, event.hn, event.at, newId);
    case 'request_move':
        return requestMove(state, event, newId);
    case 'rooms_snapshot': {
        const arrived = (m: IMove) => m.identityId !== undefined
            && event.rooms.some(r => r.name === m.destination && r.occupants.some(o => o.identity?.id === m.identityId));
        const cancelled = (m: IMove) => event.rooms.some(r => r.name === m.origin
            && r.occupants.some(o => o.endpointId === m.endpointId && o.cancelledMove === m.id));
        const next = (m: IMove): IMove => {
            if (m.state !== 'counting_down') {
                return m;
            }
            if (arrived(m)) {
                return { ...m, state: 'done' };
            }

            return cancelled(m) ? { ...m, state: 'cancelled' } : m;
        };

        return { commands: [], state: { ...state, moves: state.moves.map(next) } };
    }
    case 'timer_fired':
        return {
            commands: [],
            state: {
                ...state,
                moves: state.moves.map(m => m.id === event.moveId && m.state === 'counting_down'
                    ? { ...m, reason: 'participant_did_not_arrive', state: 'failed' as const }
                    : m)
            }
        };
    }
}
