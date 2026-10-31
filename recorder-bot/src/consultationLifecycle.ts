/**
 * The consultation lifecycle module: owns the stop rule and the timeline of one consultation, and summarises its
 * participants, tracks and staff visits for the manifest.
 *
 * It is pure. It takes timestamped events and returns timeline entries and commands. It does no I/O and has no
 * timers of its own: the caller runs the timers it asks for and reports back with a `timer_fired` event.
 */

export type Role = 'staff' | 'patient' | 'unknown';
export type Timer = 'first_join' | 'empty_room';
export type StopReason = 'room_destroyed' | 'no_humans_for_grace' | 'no_one_joined' | 'kicked' | 'shutdown';

export type TrackKind = 'audio' | 'video';

/** A participant's server-verified identity, when the deployment provides one. */
export interface IIdentity {
    id: string;
    name?: string;
}

export type LifecycleEvent = { at: Date; } & (
    | { meetingId?: string; type: 'bot_joined'; }
    | {
        displayName?: string;
        endpointId: string;

        /** A participant on the hidden domain, such as another recorder. Never counted as a human. */
        hidden?: boolean;
        identity?: IIdentity;
        role: Role;
        type: 'participant_joined';
    }
    | { endpointId: string; type: 'participant_left'; }
    | { endpointId: string; file: string; kind: TrackKind; type: 'track_started'; }
    | { file: string; type: 'track_stopped'; }

    /** The resolution a video track is received at changed. */
    | { file: string; height: number; type: 'video_resolution'; width: number; }
    | { type: 'room_destroyed'; }
    | { type: 'kicked'; }

    /** The recorder bot service is shutting down. */
    | { type: 'shutdown'; }
    | { type: 'bot_interrupted'; }
    | { type: 'bot_resumed'; }
    | { timer: Timer; type: 'timer_fired'; }
);

export type LifecycleCommand =
    | { ms: number; timer: Timer; type: 'start_timer'; }
    | { timer: Timer; type: 'cancel_timer'; }
    | { reason: StopReason; type: 'stop'; };

export type TimelineEntry = { at: Date; } & (
    | { meetingId?: string; type: 'bot_joined'; }
    | {
        displayName?: string;
        endpointId: string;
        hidden?: true;
        identity?: IIdentity;
        role: Role;
        type: 'participant_joined';
    }
    | { endpointId: string; type: 'participant_left'; }
    | { endpointId: string; file: string; kind: TrackKind; type: 'track_started'; }
    | { file: string; type: 'track_stopped'; }
    | { file: string; height: number; type: 'video_resolution'; width: number; }
    | { type: 'bot_interrupted'; }
    | { type: 'bot_resumed'; }

    /** A stretch of the consultation the recorder bot did not capture. */
    | { end: Date; start: Date; type: 'gap'; }
    | { reason: StopReason; type: 'stopped'; }
);

export interface IStaffVisit {
    displayName?: string;

    /** When the visit ended; undefined while it is still in progress. */
    end?: Date;
    endpointId: string;
    identity?: IIdentity;
    start: Date;
}

/** A participant as the consultation saw it. A rejoin is a new endpoint, so a new participant. */
export interface IParticipant {
    displayName?: string;
    endpointId: string;
    hidden?: true;
    identity?: IIdentity;
    joins: Date[];
    leaves: Date[];
    role: Role;
}

/** One recorded track: one file. */
export interface ITrack {
    endpointId: string;
    file: string;
    kind: TrackKind;
    start: Date;

    /** When the track stopped; undefined while it is still recorded. A track open at the stop ends then. */
    stop?: Date;
}

export interface ILifecycleOptions {

    /** How long the room may stay without a human once one has been present. Defaults to 60 seconds. */
    emptyRoomMs?: number;

    /** How long to wait for the first human after the bot joined. Defaults to 10 minutes. */
    firstJoinMs?: number;
}

export interface ILifecycleResult {
    commands: LifecycleCommand[];
    entries: TimelineEntry[];
}

export interface IConsultationLifecycle {

    /**
     * Applies one event.
     *
     * @param {LifecycleEvent} event - The event.
     * @returns {ILifecycleResult} The timeline entries and commands the event produced.
     */
    handle: (event: LifecycleEvent) => ILifecycleResult;

    /**
     * Returns the participants so far, in the order they first joined, with when they joined and left.
     *
     * @returns {IParticipant[]}
     */
    participants: () => IParticipant[];

    /**
     * Returns the staff visits so far, in the order they started. A visit still open when the consultation stopped
     * ends at the stop time.
     *
     * @returns {IStaffVisit[]}
     */
    staffVisits: () => IStaffVisit[];

    /**
     * Returns the tracks so far, in the order they started.
     *
     * @returns {ITrack[]}
     */
    tracks: () => ITrack[];
}

export const DEFAULT_FIRST_JOIN_MS = 10 * 60 * 1000;
export const DEFAULT_EMPTY_ROOM_MS = 60 * 1000;

/**
 * Returns a result with no entries and no commands.
 *
 * @returns {ILifecycleResult}
 */
function nothing(): ILifecycleResult {
    return { commands: [], entries: [] };
}

const TIMER_STOP_REASONS: Record<Timer, StopReason> = {
    'empty_room': 'no_humans_for_grace',
    'first_join': 'no_one_joined'
};

/**
 * Creates the lifecycle of one consultation.
 *
 * @param {ILifecycleOptions} options - Timer durations.
 * @returns {IConsultationLifecycle}
 */
export function createConsultationLifecycle(options: ILifecycleOptions = {}): IConsultationLifecycle {
    const firstJoinMs = options.firstJoinMs ?? DEFAULT_FIRST_JOIN_MS;
    const emptyRoomMs = options.emptyRoomMs ?? DEFAULT_EMPTY_ROOM_MS;
    const humans = new Set<string>();
    const hidden = new Set<string>();
    const visits: IStaffVisit[] = [];
    const openVisits = new Map<string, IStaffVisit>();
    const activeTimers = new Set<Timer>();
    const tracks: ITrack[] = [];
    const openTracks = new Map<string, ITrack>();
    const participants = new Map<string, IParticipant>();

    /**
     * Returns the command that starts a timer, and remembers it as active.
     *
     * @param {Timer} timer - The timer.
     * @param {number} ms - Its duration.
     * @returns {LifecycleCommand}
     */
    function startTimer(timer: Timer, ms: number): LifecycleCommand {
        activeTimers.add(timer);

        return { ms, timer, type: 'start_timer' };
    }

    /**
     * Returns the commands that cancel a timer if it is active.
     *
     * @param {Timer} timer - The timer.
     * @returns {LifecycleCommand[]}
     */
    function cancelTimer(timer: Timer): LifecycleCommand[] {
        return activeTimers.delete(timer) ? [ { timer, type: 'cancel_timer' } ] : [];
    }

    let stopped = false;
    let interruptedAt: Date | undefined;

    /**
     * Closes the current interruption, if any.
     *
     * @param {Date} at - When the interruption ended.
     * @returns {TimelineEntry[]} The gap entry.
     */
    function closeGap(at: Date): TimelineEntry[] {
        const start = interruptedAt;

        interruptedAt = undefined;

        return start ? [ { at, end: at, start, type: 'gap' } ] : [];
    }

    /**
     * Stops the consultation: cancels the running timers, ends the open visits, gap and tracks, and records why.
     *
     * @param {Date} at - When.
     * @param {StopReason} reason - Why.
     * @returns {ILifecycleResult}
     */
    function stop(at: Date, reason: StopReason): ILifecycleResult {
        stopped = true;

        for (const visit of openVisits.values()) {
            visit.end = at;
        }
        openVisits.clear();

        const trackStops: TimelineEntry[] = [ ...openTracks.values() ].map(track => {
            track.stop = at;

            return { at, file: track.file, type: 'track_stopped' };
        });

        openTracks.clear();

        return {
            entries: [ ...closeGap(at), ...trackStops, { at, reason, type: 'stopped' } ],
            commands: [
                ...[ ...activeTimers ].flatMap(cancelTimer),
                { reason, type: 'stop' }
            ]
        };
    }

    return {
        handle(event) {
            if (stopped) {
                return nothing();
            }

            switch (event.type) {
            case 'bot_joined':
                return {
                    entries: [ { at: event.at, meetingId: event.meetingId, type: 'bot_joined' } ],
                    commands: humans.size ? [] : [ startTimer('first_join', firstJoinMs) ]
                };
            case 'participant_joined': {
                const { at, displayName, endpointId, identity, role } = event;
                let participant = participants.get(endpointId);

                if (!participant) {
                    participant = {
                        displayName,
                        endpointId,
                        ...event.hidden ? { hidden: true } as const : {},
                        identity,
                        joins: [],
                        leaves: [],
                        role
                    };
                    participants.set(endpointId, participant);
                }
                participant.joins.push(at);

                if (event.hidden) {
                    hidden.add(endpointId);

                    return {
                        entries: [
                            { at, displayName, endpointId, hidden: true, identity, role, type: 'participant_joined' }
                        ],
                        commands: []
                    };
                }

                humans.add(endpointId);

                if (role === 'staff') {
                    const visit = { displayName, end: undefined, endpointId, identity, start: at };

                    visits.push(visit);
                    openVisits.set(endpointId, visit);
                }

                return {
                    entries: [ { at, displayName, endpointId, identity, role, type: 'participant_joined' } ],
                    commands: [ ...cancelTimer('first_join'), ...cancelTimer('empty_room') ]
                };
            }
            case 'participant_left': {
                const { at, endpointId } = event;

                participants.get(endpointId)?.leaves.push(at);

                if (hidden.delete(endpointId)) {
                    return { entries: [ { at, endpointId, type: 'participant_left' } ], commands: [] };
                }

                humans.delete(endpointId);

                const visit = openVisits.get(endpointId);

                if (visit) {
                    visit.end = at;
                    openVisits.delete(endpointId);
                }

                return {
                    entries: [ { at, endpointId, type: 'participant_left' } ],
                    commands: humans.size ? [] : [ startTimer('empty_room', emptyRoomMs) ]
                };
            }
            case 'track_started': {
                const { at, endpointId, file, kind } = event;
                const track = { endpointId, file, kind, start: at, stop: undefined };

                tracks.push(track);
                openTracks.set(file, track);

                return { entries: [ { at, endpointId, file, kind, type: 'track_started' } ], commands: [] };
            }
            case 'track_stopped': {
                const track = openTracks.get(event.file);

                if (track) {
                    track.stop = event.at;
                    openTracks.delete(event.file);
                }


                return { entries: [ { at: event.at, file: event.file, type: 'track_stopped' } ], commands: [] };
            }
            case 'video_resolution': {
                const { at, file, height, width } = event;

                return { entries: [ { at, file, height, type: 'video_resolution', width } ], commands: [] };
            }
            case 'bot_interrupted':
                interruptedAt ??= event.at;

                return { entries: [ { at: event.at, type: 'bot_interrupted' } ], commands: [] };
            case 'bot_resumed':
                return { entries: [ { at: event.at, type: 'bot_resumed' }, ...closeGap(event.at) ], commands: [] };
            case 'room_destroyed':
                return stop(event.at, 'room_destroyed');
            case 'kicked':
                return stop(event.at, 'kicked');
            case 'shutdown':
                return stop(event.at, 'shutdown');
            case 'timer_fired':
                if (!activeTimers.delete(event.timer)) {
                    return nothing();
                }

                return stop(event.at, TIMER_STOP_REASONS[event.timer]);
            }
        },

        participants() {
            return [ ...participants.values() ].map(p => ({ ...p, joins: [ ...p.joins ], leaves: [ ...p.leaves ] }));
        },

        staffVisits() {
            return visits.map(visit => ({ ...visit }));
        },

        tracks() {
            return tracks.map(track => ({ ...track }));
        }
    };
}
