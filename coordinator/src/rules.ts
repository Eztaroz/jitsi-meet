/**
 * The rules module: owns the coordinator service's encounters, stages, queues, room rules and moves.
 *
 * It is pure. It takes timestamped events and returns the new state, the commands the caller must carry out and the
 * result for the caller's request. It does no I/O and has no timers of its own.
 */
import { randomUUID } from 'node:crypto';

export type Stage = 'waiting' | 'intake' | 'examination' | 'aftercare' | 'done';

export interface IEncounter {

    /** Every stage the encounter has been in, with when it entered it. */
    history: { at: Date; stage: Stage; }[];
    hn: string;

    /** Opaque; never derived from the HN. */
    id: string;
    stage: Stage;

    /** When the encounter entered its current stage: the queue is ordered by it. */
    stageStartedAt: Date;
    startedAt: Date;

    /** True for an encounter that was closed at the end of the day, not marked done. */
    unfinished?: true;
}

export const STAGES: readonly Stage[] = [ 'waiting', 'intake', 'examination', 'aftercare', 'done' ];

/** One patient's place in a stage's queue. */
export interface IQueueEntry {
    encounterId: string;
    enteredAt: Date;

    /** The first of its queue: who the system suggests is next. */
    suggested: boolean;
    waitedSeconds: number;
}

export type Queues = Record<Exclude<Stage, 'done'>, IQueueEntry[]>;

/** How long the moved participant's notice counts down before their client leaves, in milliseconds. */
export const COUNTDOWN_MS = 5000;

/** How long a participant has, after the countdown, to appear in the destination, in milliseconds. */
export const ARRIVAL_WAIT_MS = 30_000;

/** How long the recorder bot has to be in a destination that was closed before the participant is sent, in ms. */
export const PREPARE_WAIT_MS = 30_000;

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

    /** Set when the move takes a patient into a station, where they are recorded (ADR 0006). */
    station?: { hn: string; patientId: string; };
}

export interface IState {
    encounters: IEncounter[];
    moves: IMove[];

    /** Where each patient's own room is, by their verified identity id: learned from where they are seen. */
    patientRooms: Record<string, string>;
}

/** The patient and the station they are moved into, which travel together while their time there is recorded (ADR 0006). */
export interface IStationConsultation {

    /** The patient's verified identity id. */
    patientId: string;

    /** The station. */
    room: string;
}

/** A room as the rooms module describes it; only what the rules need. */
export interface IRoomView {

    /** What the room is. A room that is not configured as a station or a lounge is a patient's own. */
    kind?: 'lounge' | 'patient' | 'station';
    name: string;

    occupants: {

        /** The id of the move this occupant says they cancel. */
        cancelledMove?: string;
        endpointId: string;
        identity?: { id?: string; };
        role: 'hidden' | 'patient' | 'staff' | 'unknown';
    }[];
    /** False for a configured room that nobody is in. Defaults to true. */
    open?: boolean;
}

export type RulesEvent = { at: Date; } & (
    | { hn: string; type: 'start_encounter'; }
    | { encounterId: string; stage: Stage; type: 'change_stage'; }

    /** The day ends: the encounters still open are closed as unfinished. */
    | { type: 'close_day'; }
    | { endpointId: string; fromRoom: string; rooms: IRoomView[]; toRoom: string; type: 'request_move'; }
    | { rooms: IRoomView[]; type: 'rooms_snapshot'; }
    | { moveId: string; timer: 'move_arrival' | 'move_prepare'; type: 'timer_fired'; }

    /** The recorder bot is in the destination the participant was waiting for. */
    | { moveId: string; type: 'destination_ready'; }
    | { moveId: string; reason: 'could_not_send_move' | 'recorder_bot_at_capacity' | 'recorder_bot_unreachable'; type: 'destination_failed'; }
);

export type Command =
    | { hn: string; type: 'record_room'; }
    | { destination: string; endpointId: string; moveId: string; room: string; type: 'send_move'; }
    | { afterMs: number; moveId: string; timer: 'move_arrival' | 'move_prepare'; type: 'start_timer'; }

    /** Open the destination, a patient's own room, by asking the recorder bot to record it, and report back. */
    | { hn: string; moveId: string; station?: IStationConsultation; type: 'prepare_destination'; }

    /** Stop the consultation started in a station for a move that did not bring the patient. Nothing is kept. */
    | { moveId: string; type: 'stop_station_consultation'; };

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
    refused?: 'encounter_closed' | 'unknown_encounter';
    state: IState;
}

/**
 * Returns the state of a service with no encounters.
 *
 * @returns {IState}
 */
export function initialState(): IState {
    return { encounters: [], moves: [], patientRooms: {} };
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

    const encounter: IEncounter = {
        history: [ { at, stage: 'waiting' } ],
        hn,
        id: newId(),
        stage: 'waiting',
        stageStartedAt: at,
        startedAt: at
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
 * The command that stops what a move started in a station, for a move that ended without the patient arriving.
 *
 * @param {IMove|undefined} move - The move.
 * @returns {Command[]}
 */
function stopStation(move: IMove | undefined): Command[] {
    return move?.station ? [ { moveId: move.id, type: 'stop_station_consultation' } ] : [];
}

/** The states of a move that is under way. */
const ACTIVE: ReadonlySet<MoveState> = new Set([ 'counting_down', 'preparing' ]);

/** The commands that send a participant and wait for them to arrive. */
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
 * @returns {Queues}
 */
export function queues(state: IState, now: Date): Queues {
    const result: Queues = { aftercare: [], examination: [], intake: [], waiting: [] };

    for (const stage of Object.keys(result) as (keyof Queues)[]) {
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
 * Starts a move, or refuses it.
 *
 * @param {IState} state - The current state.
 * @param {RulesEvent} event - The request.
 * @param {() => string} newId - Makes an opaque id.
 * @returns {IStep}
 */
function requestMove(
        startState: IState,
        event: RulesEvent & { type: 'request_move'; },
        newId: () => string,
        prepareWaitMs: number
): IStep {
    const state = learnPatientRooms(startState, event.rooms);
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
    const destinationOpen = destination !== undefined && destination.open !== false;
    const toLounge = destination?.kind === 'lounge';
    const toStation = destination?.kind === 'station';
    const isPatient = occupant?.role === 'patient';

    // A patient in a station is recorded under their HN, which is their own room's name.
    const patientHn = !isPatient ? undefined
        : origin?.kind === undefined || origin.kind === 'patient' ? event.fromRoom
            : base.identityId ? state.patientRooms[base.identityId] : undefined;
    let reason: string | undefined;
    let prepare = false;

    if (!occupant) {
        reason = 'participant_not_found';
    } else if (occupant.role !== 'staff' && !isPatient) {
        reason = 'participant_not_movable';
    } else if (isPatient && toLounge) {
        reason = 'patient_into_lounge';
    } else if (isPatient && !toStation && (!base.identityId || state.patientRooms[base.identityId] !== event.toRoom)) {
        // Anything that is neither a station nor a lounge is a patient's own room (ADR 0005).
        reason = 'not_the_patients_room';
    } else if (isPatient && destinationOpen
            && destination.occupants.some(o => o.role === 'patient' && o.identity?.id !== occupant.identity?.id)) {
        reason = 'destination_holds_a_patient';
    } else if (!destinationOpen) {
        // Only a patient's own room is opened for a move, and only for a patient.
        prepare = isPatient && (destination === undefined || destination.kind === 'patient');
        if (!prepare) {
            reason = 'destination_not_open';
        }
    } else if (isPatient && toStation && (!base.identityId || !patientHn)) {
        reason = base.identityId ? 'patient_room_unknown' : 'participant_not_movable';
    }
    if (!reason && state.moves.some(m => ACTIVE.has(m.state) && sameParticipant(m, base))) {
        reason = 'already_being_moved';
    }

    if (reason) {
        const refused: IMove = { ...base, reason, state: 'refused' };

        return { commands: [], move: refused, state: { ...state, moves: [ ...state.moves, refused ] } };
    }

    const station = isPatient && toStation && patientHn && base.identityId
        ? { hn: patientHn, patientId: base.identityId }
        : undefined;

    if (prepare || station) {
        const preparing: IMove = { ...base, state: 'preparing', ...station ? { station } : {} };

        return {
            commands: [
                station
                    ? {
                        hn: station.hn,
                        moveId: preparing.id,
                        station: { patientId: station.patientId, room: event.toRoom },
                        type: 'prepare_destination'
                    }
                    : { hn: event.toRoom, moveId: preparing.id, type: 'prepare_destination' },
                { afterMs: prepareWaitMs, moveId: preparing.id, timer: 'move_prepare', type: 'start_timer' }
            ],
            move: preparing,
            state: { ...state, moves: [ ...state.moves, preparing ] }
        };
    }

    const move: IMove = { ...base, state: 'counting_down' };

    return {
        commands: sendCommands(move),
        move,
        state: { ...state, moves: [ ...state.moves, move ] }
    };
}

/**
 * Applies one event.
 *
 * @param {IState} state - The current state.
 * @param {RulesEvent} event - The event.
 * @param {() => string} newId - Makes an opaque id; replaceable by callers that need determinism.
 * @param {number} prepareWaitMs - How long a move waits for its closed destination to be opened.
 * @returns {IStep}
 */
export function step(
        state: IState,
        event: RulesEvent,
        newId: () => string = randomUUID,
        prepareWaitMs: number = PREPARE_WAIT_MS
): IStep {
    switch (event.type) {
    case 'start_encounter':
        return startEncounter(state, event.hn, event.at, newId);
    case 'request_move':
        return requestMove(state, event, newId, prepareWaitMs);
    case 'change_stage': {
        const encounter = state.encounters.find(e => e.id === event.encounterId);

        if (!encounter) {
            return { commands: [], refused: 'unknown_encounter', state };
        }
        if (encounter.stage === 'done') {
            return { commands: [], refused: 'encounter_closed', state };
        }

        const changed = enter(encounter, event.stage, event.at);

        return {
            commands: [],
            encounter: { ...changed, created: false },
            state: { ...state, encounters: state.encounters.map(e => e === encounter ? changed : e) }
        };
    }
    case 'close_day':
        // The day's encounters end, and with them what was learned about where their patients' rooms are.
        return {
            commands: [],
            state: {
                ...state,
                patientRooms: {},
                encounters: state.encounters.map(e => e.stage === 'done'
                    ? e
                    : { ...enter(e, 'done', event.at), unfinished: true as const })
            }
        };
    case 'rooms_snapshot': {
        const learned = learnPatientRooms(state, event.rooms);
        const arrived = (m: IMove) => m.identityId !== undefined
            && event.rooms.some(r => r.name === m.destination && r.occupants.some(o => o.identity?.id === m.identityId));
        const cancelled = (m: IMove) => event.rooms.some(r => r.name === m.origin
            && r.occupants.some(o => o.endpointId === m.endpointId && o.cancelledMove === m.id));
        const commands: Command[] = [];
        const next = (m: IMove): IMove => {
            if (m.state !== 'counting_down') {
                return m;
            }
            if (arrived(m)) {
                return { ...m, state: 'done' };
            }
            if (cancelled(m)) {
                commands.push(...stopStation(m));

                return { ...m, state: 'cancelled' };
            }

            return m;
        };

        return { commands, state: { ...learned, moves: learned.moves.map(next) } };
    }
    case 'destination_ready': {
        const move = state.moves.find(m => m.id === event.moveId && m.state === 'preparing');

        if (!move) {
            return { commands: [], state };
        }

        const sent: IMove = { ...move, state: 'counting_down' };

        return {
            commands: sendCommands(sent),
            state: { ...state, moves: state.moves.map(m => m.id === move.id ? sent : m) }
        };
    }
    case 'destination_failed': {
        const move = state.moves.find(m => m.id === event.moveId && ACTIVE.has(m.state));

        return {
            commands: stopStation(move),
            state: {
                ...state,
                moves: state.moves.map(m => m === move ? { ...m, reason: event.reason, state: 'failed' as const } : m)
            }
        };
    }
    case 'timer_fired': {
        const [ from, reason ] = event.timer === 'move_arrival'
            ? [ 'counting_down', 'participant_did_not_arrive' ] as const
            : [ 'preparing', 'recorder_bot_not_ready' ] as const;
        const move = state.moves.find(m => m.id === event.moveId && m.state === from);

        return {
            commands: stopStation(move),
            state: {
                ...state,
                moves: state.moves.map(m => m === move ? { ...m, reason, state: 'failed' as const } : m)
            }
        };
    }
    }
}
