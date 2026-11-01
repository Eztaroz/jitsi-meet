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

export interface IState {
    encounters: IEncounter[];
}

export type FlowEvent = { at: Date; } & { hn: string; type: 'start_encounter'; };

export type Command = { hn: string; type: 'record_room'; };

export interface IStartResult extends IEncounter {

    /** False when the HN already had an open encounter. */
    created: boolean;
}

export interface IStep {
    commands: Command[];
    result?: IStartResult;
    state: IState;
}

/**
 * Returns the state of a service with no encounters.
 *
 * @returns {IState}
 */
export function initialState(): IState {
    return { encounters: [] };
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
    const open = state.encounters.find(e => e.hn === event.hn && e.stage !== 'done');

    if (open) {
        return { commands: [], result: { ...open, created: false }, state };
    }

    const encounter: IEncounter = { hn: event.hn, id: newId(), stage: 'waiting', startedAt: event.at };

    return {
        commands: [ { hn: event.hn, type: 'record_room' } ],
        result: { ...encounter, created: true },
        state: { encounters: [ ...state.encounters, encounter ] }
    };
}
