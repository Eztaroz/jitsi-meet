/**
 * The rules module: owns the coordinator service's encounters, stages, queues, room rules and moves.
 *
 * It is pure. It takes timestamped events and returns the new state, the commands the caller must carry out and the
 * result for the caller's request. It does no I/O and has no timers of its own.
 */
import { randomUUID } from 'node:crypto';

import { DEFAULT_PATHWAY, DEFAULT_PATHWAY_ID, DONE, WAITING } from './pathways.ts';

/** A stage's id, as the encounter's pathway configures it (ADR 0013). */
export type Stage = string;

export interface IEncounter {

    /** The center the encounter belongs to. */
    center?: string;

    /** The clinic the encounter is for, if the request that started it named one. */
    clinic?: string;

    /** Every stage the encounter has been in, with when it entered it. */
    history: { at: Date; stage: Stage; }[];
    hn: string;

    /** Opaque; never derived from the HN. */
    id: string;

    /** The id of the pathway the encounter follows, resolved when it started (ADR 0013). */
    pathway: string;
    stage: Stage;

    /** When the encounter entered its current stage: the queue is ordered by it. */
    stageStartedAt: Date;
    startedAt: Date;

    /** True for an encounter that was closed at the end of the day, not marked done. */
    unfinished?: true;

    /** The hospital system's number for the patient's attendance on the day; several encounters can share one. */
    visitNumber?: string;
}

/** One patient's place in a stage's queue. */
export interface IQueueEntry {

    /** The stations whose staff are in the patient's room now; set by the service, which sees the rooms. */
    at?: string[];
    encounterId: string;
    enteredAt: Date;

    /** The first of its queue: who the system suggests is next. */
    suggested: boolean;
    waitedSeconds: number;
}

/** The queues by stage id; `done` has none. */
export type Queues = Record<string, IQueueEntry[]>;

/** How long the moved participant's notice counts down before their client leaves, in milliseconds. */
export const COUNTDOWN_MS = 5000;

/** How long a participant has, after the countdown, to appear in the destination, in milliseconds. */
export const ARRIVAL_WAIT_MS = 30_000;

/**
 * What a move is. `preparing` is only ever read back from a database of the time when patients were moved, and such a
 * move is failed when the service starts (ADR 0011).
 */
export type MoveState = 'cancelled' | 'counting_down' | 'done' | 'failed' | 'preparing' | 'refused';

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

    /** Where each patient's own room is, by their verified identity id: learned from where they are seen. */
    patientRooms: Record<string, string>;

    /**
     * The station of each staff member, by their verified identity id: the one whose lounge they were last seen in
     * (ADR 0011).
     */
    staffStations: Record<string, string>;
}

/** A room as the rooms module describes it; only what the rules need. */
export interface IRoomView {

    /** What the room is. A room that is not configured as a lounge is a patient's own. */
    kind?: 'lounge' | 'patient';
    name: string;

    occupants: {

        /** The id of the move this occupant says they cancel. */
        cancelledMove?: string;
        endpointId: string;
        identity?: { id?: string; };
        role: 'hidden' | 'patient' | 'staff' | 'unknown';
    }[];

    /** False for a lounge that nobody is in. Defaults to true. */
    open?: boolean;

    /** For a lounge, its station. */
    station?: string;
}

export type RulesEvent = { at: Date; } & (
    | {
        center?: string;
        clinic?: string;
        hn: string;

        /** The id of the resolved pathway; the default one when unset. */
        pathway?: string;
        type: 'start_encounter';
        visitNumber?: string;
    }
    | {
        encounterId: string;

        /** The stage ids of the encounter's pathway; the default pathway's when unset. */
        pathwayStages?: readonly string[];
        stage: Stage;
        type: 'change_stage';
    }

    /** The day ends: the encounters still open are closed as unfinished. */
    | { type: 'close_day'; }
    | { endpointId: string; fromRoom: string; rooms: IRoomView[]; toRoom: string; type: 'request_move'; }
    | { rooms: IRoomView[]; type: 'rooms_snapshot'; }
    | { moveId: string; timer: 'move_arrival'; type: 'timer_fired'; }

    /** A move cannot go on: its command could not be sent, or it was left from when patients were moved. */
    | { moveId: string; reason: 'could_not_send_move' | 'patient_moves_retired'; type: 'move_failed'; }
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

    /** Why a request to change a stage was refused. */
    refused?: 'encounter_closed' | 'stage_not_in_pathway' | 'unknown_center' | 'unknown_clinic' | 'unknown_encounter';
    state: IState;
}

/**
 * Returns the state of a service with no encounters.
 *
 * @returns {IState}
 */
export function initialState(): IState {
    return { encounters: [], moves: [], patientRooms: {}, staffStations: {} };
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
function startEncounter(state: IState, event: RulesEvent & { type: 'start_encounter'; }, newId: () => string): IStep {
    const { at, hn } = event;
    const open = state.encounters.find(e => e.hn === hn && e.stage !== DONE);

    if (open) {
        return { commands: [], encounter: { ...open, created: false }, state };
    }

    const encounter: IEncounter = {
        history: [ { at, stage: WAITING } ],
        hn,
        id: newId(),
        pathway: event.pathway ?? DEFAULT_PATHWAY_ID,
        stage: WAITING,
        stageStartedAt: at,
        startedAt: at,
        ...event.center === undefined ? {} : { center: event.center },
        ...event.clinic === undefined ? {} : { clinic: event.clinic },
        ...event.visitNumber === undefined ? {} : { visitNumber: event.visitNumber }
    };

    return {
        commands: [ { hn, type: 'record_room' } ],
        encounter: { ...encounter, created: true },
        state: { ...state, encounters: [ ...state.encounters, encounter ] }
    };
}

/**
 * Learns where patients' own rooms are: a patient seen in a patient's room is that room's.
 *
 * @param {IState} state - The state.
 * @param {IRoomView[]} rooms - The rooms.
 * @returns {IState} The state, the same when nothing is new.
 */
function learnPatientRooms(state: IState, rooms: IRoomView[]): IState {
    let learned: Record<string, string> | undefined;

    for (const room of rooms) {
        if (room.kind !== undefined && room.kind !== 'patient') {
            continue;
        }
        for (const o of room.occupants) {
            if (o.role === 'patient' && o.identity?.id && state.patientRooms[o.identity.id] !== room.name) {
                learned ??= { ...state.patientRooms };
                learned[o.identity.id] = room.name;
            }
        }
    }

    return learned ? { ...state, patientRooms: learned } : state;
}

/**
 * Learns the station of each staff member: a staff member seen in a station's lounge is with that station, and stays
 * with it while they are in patients' rooms (ADR 0011).
 *
 * @param {IState} state - The state.
 * @param {IRoomView[]} rooms - The rooms.
 * @returns {IState} The state, the same when nothing is new.
 */
export function learnStaffStations(state: IState, rooms: IRoomView[]): IState {
    let learned: Record<string, string> | undefined;

    for (const room of rooms) {
        if (room.kind !== 'lounge' || !room.station) {
            continue;
        }
        for (const o of room.occupants) {
            if (o.role === 'staff' && o.identity?.id && state.staffStations[o.identity.id] !== room.station) {
                learned ??= { ...state.staffStations };
                learned[o.identity.id] = room.station;
            }
        }
    }

    return learned ? { ...state, staffStations: learned } : state;
}

/**
 * Learns what the rooms tell about patients' own rooms and staff's stations.
 *
 * @param {IState} state - The state.
 * @param {IRoomView[]} rooms - The rooms.
 * @returns {IState} The state, the same when nothing is new.
 */
function learn(state: IState, rooms: IRoomView[]): IState {
    return learnStaffStations(learnPatientRooms(state, rooms), rooms);
}

/**
 * The commands that send a participant and wait for them to arrive.
 *
 * @param {IMove} move - The move.
 * @returns {Command[]}
 */
function sendCommands(move: IMove): Command[] {
    return [
        { destination: move.destination, endpointId: move.endpointId, moveId: move.id, room: move.origin, type: 'send_move' },
        { afterMs: COUNTDOWN_MS + ARRIVAL_WAIT_MS, moveId: move.id, timer: 'move_arrival', type: 'start_timer' }
    ];
}

/**
 * Tells whether two moves are of the same participant: the same verified identity, or the same endpoint in the same
 * room.
 *
 * @param {IMove} a - One move.
 * @param {Pick<IMove, 'endpointId' | 'identityId' | 'origin'>} b - The other.
 * @returns {boolean}
 */
function sameParticipant(a: IMove, b: Pick<IMove, 'endpointId' | 'identityId' | 'origin'>): boolean {
    const sameIdentity = a.identityId !== undefined && a.identityId === b.identityId;
    const sameEndpoint = a.origin === b.origin && a.endpointId === b.endpointId;

    return sameIdentity || sameEndpoint;
}

/**
 * Puts an encounter in a stage.
 *
 * @param {IEncounter} encounter - The encounter.
 * @param {Stage} stage - The stage.
 * @param {Date} at - When.
 * @returns {IEncounter}
 */
function enter(encounter: IEncounter, stage: Stage, at: Date): IEncounter {
    return { ...encounter, history: [ ...encounter.history, { at, stage } ], stage, stageStartedAt: at };
}

/**
 * Returns the queues: for each stage, the open encounters in it, the longest-waiting first.
 *
 * @param {IState} state - The state.
 * @param {Date} now - When.
 * @param {string[]} stages - The ids of the configured stages; each has a queue, empty or not. The default
 * pathway's when unset.
 * @returns {Queues}
 */
export function queues(state: IState, now: Date, stages: readonly string[] = DEFAULT_PATHWAY.stages.map(s => s.id)): Queues {
    const result: Queues = {};
    const open = state.encounters.filter(e => e.stage !== DONE).map(e => e.stage);

    for (const stage of new Set([ ...stages, ...open ])) {
        if (stage === DONE) {
            continue;
        }
        result[stage] = state.encounters
            .filter(e => e.stage === stage)
            .map((e, index) => ({ e, index }))
            .sort((x, y) => x.e.stageStartedAt.getTime() - y.e.stageStartedAt.getTime() || x.index - y.index)
            .map(({ e }, i) => ({
                encounterId: e.id,
                enteredAt: e.stageStartedAt,
                suggested: i === 0,
                waitedSeconds: Math.max(0, Math.floor((now.getTime() - e.stageStartedAt.getTime()) / 1000))
            }));
    }

    return result;
}

/**
 * Starts a move, or refuses it. Only staff are moved: into a patient's own room while it is open, or into a lounge,
 * open or not. Patients stay in their own room (ADR 0011).
 *
 * @param {IState} startState - The current state.
 * @param {RulesEvent} event - The request.
 * @param {() => string} newId - Makes an opaque id.
 * @returns {IStep}
 */
function requestMove(startState: IState, event: RulesEvent & { type: 'request_move'; }, newId: () => string): IStep {
    const state = learn(startState, event.rooms);
    const origin = event.rooms.find(r => r.name === event.fromRoom);
    const occupant = origin?.occupants.find(o => o.endpointId === event.endpointId);
    const base = {
        destination: event.toRoom,
        endpointId: event.endpointId,
        id: newId(),
        identityId: occupant?.identity?.id,
        origin: event.fromRoom,
        startedAt: event.at
    };
    const destination = event.rooms.find(r => r.name === event.toRoom);
    let reason: string | undefined;

    if (!occupant) {
        reason = 'participant_not_found';
    } else if (occupant.role === 'patient') {
        reason = 'patients_never_move';
    } else if (occupant.role !== 'staff') {
        reason = 'participant_not_movable';
    } else if (!destination || (destination.kind !== 'lounge' && destination.open === false)) {
        // A lounge nobody is in opens as staff come into it; a patient's room is open while the patient is in it.
        reason = 'destination_not_open';
    } else if (state.moves.some(m => m.state === 'counting_down' && sameParticipant(m, base))) {
        reason = 'already_being_moved';
    }

    if (reason) {
        const refused: IMove = { ...base, reason, state: 'refused' };

        return { commands: [], move: refused, state: { ...state, moves: [ ...state.moves, refused ] } };
    }

    const move: IMove = { ...base, state: 'counting_down' };

    return {
        commands: sendCommands(move),
        move,
        state: { ...state, moves: [ ...state.moves, move ] }
    };
}

/**
 * Fails a move that is under way.
 *
 * @param {IState} state - The state.
 * @param {string} moveId - The move.
 * @param {string} reason - Why.
 * @returns {IStep}
 */
function fail(state: IState, moveId: string, reason: string): IStep {
    const move = state.moves.find(m => m.id === moveId && (m.state === 'counting_down' || m.state === 'preparing'));

    return {
        commands: [],
        state: move
            ? { ...state, moves: state.moves.map(m => m === move ? { ...m, reason, state: 'failed' as const } : m) }
            : state
    };
}

/**
 * Applies one event.
 *
 * @param {IState} state - The current state.
 * @param {RulesEvent} event - The event.
 * @param {() => string} newId - Makes an opaque id; replaceable by callers that need determinism.
 * @returns {IStep}
 */
export function step(state: IState, event: RulesEvent, newId: () => string = randomUUID): IStep {
    switch (event.type) {
    case 'start_encounter':
        return startEncounter(state, event, newId);
    case 'request_move':
        return requestMove(state, event, newId);
    case 'change_stage': {
        const encounter = state.encounters.find(e => e.id === event.encounterId);

        if (!encounter) {
            return { commands: [], refused: 'unknown_encounter', state };
        }
        if (encounter.stage === DONE) {
            return { commands: [], refused: 'encounter_closed', state };
        }
        if (!(event.pathwayStages ?? DEFAULT_PATHWAY.stages.map(s => s.id)).includes(event.stage)) {
            return { commands: [], refused: 'stage_not_in_pathway', state };
        }

        const changed = enter(encounter, event.stage, event.at);

        return {
            commands: [],
            encounter: { ...changed, created: false },
            state: { ...state, encounters: state.encounters.map(e => e === encounter ? changed : e) }
        };
    }
    case 'close_day':
        // The day's encounters end. What was learned about patients' own rooms and staff's stations stays until the
        // retention sweep.
        return {
            commands: [],
            state: {
                ...state,
                encounters: state.encounters.map(e => e.stage === DONE
                    ? e
                    : { ...enter(e, DONE, event.at), unfinished: true as const })
            }
        };
    case 'rooms_snapshot': {
        const learned = learn(state, event.rooms);
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
            if (cancelled(m)) {
                return { ...m, state: 'cancelled' };
            }

            return m;
        };
        const moves = learned.moves.map(next);

        return {
            commands: [],
            state: moves.some((m, i) => m !== learned.moves[i]) ? { ...learned, moves } : learned
        };
    }
    case 'move_failed':
        return fail(state, event.moveId, event.reason);
    case 'timer_fired':
        return fail(state, event.moveId, 'participant_did_not_arrive');
    }
}
