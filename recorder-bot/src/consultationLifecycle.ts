/**
 * The consultation lifecycle module: owns the stop rule and the timeline of one consultation, and summarises its
 * participants, tracks, verified identities and staff visits for the manifest.
 *
 * It is pure. It takes timestamped events and returns timeline entries and commands. It does no I/O and has no
 * timers of its own: the caller runs the timers it asks for and reports back with a `timer_fired` event.
 */

export type Role = 'staff' | 'patient' | 'unknown';
export type Timer = 'first_join' | 'empty_room' | 'patient_arrival';
export type StopReason =
    | 'room_destroyed'
    | 'no_humans_for_grace'
    | 'no_one_joined'
    | 'kicked'

    /** In a station: the patient left, though staff stay (ADR 0006). */
    | 'patient_left'

    /** In a station: the patient did not arrive in time. */
    | 'patient_did_not_arrive'

    /** The service was asked to stop it before its time. */
    | 'stop_requested'
    | 'shutdown'
    | 'bot_failed';

export type TrackKind = 'audio' | 'video';

/** A participant's server-verified identity, when the deployment provides one. */
export interface IIdentity {
    id: string;
    name?: string;
}

export type LifecycleEvent = { at: Date; } & (

    /**
     * The bot may not start the room itself (Jicofo authentication), and waits for a participant who may. The
     * first-join wait runs from here.
     */
    | { type: 'waiting_for_host'; }
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

    /** The hospital's system asked to stop the consultation before its time. */
    | { type: 'stop_requested'; }

    /** The recorder bot service is shutting down. */
    | { type: 'shutdown'; }

    /** The bot crashed or lost its connection. Until it resumes, it sees nothing. */
    | { type: 'bot_interrupted'; }

    /**
     * The relaunched bot is back in the room. It reports who is there as `participant_joined` events before this
     * one.
     */
    | { type: 'bot_resumed'; }

    /** The bot could not be relaunched. */
    | { type: 'bot_failed'; }
    | { timer: Timer; type: 'timer_fired'; }
);

export type LifecycleCommand =
    | { ms: number; timer: Timer; type: 'start_timer'; }
    | { timer: Timer; type: 'cancel_timer'; }
    | { reason: StopReason; type: 'stop'; };

export type TimelineEntry = { at: Date; } & (
    | { type: 'waiting_for_host'; }
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

/** Everything recorded of one verified identity, across its rejoins. */
export interface IIdentitySummary {

    /** Its endpoints, in the order they joined: one per join. */
    endpointIds: string[];

    /** The files of its tracks, in the order they started. */
    files: string[];
    identity: IIdentity;

    /** Its role at its first join. */
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

    /**
     * Makes this the consultation of one patient in a station (ADR 0006): the verified identity id of the patient.
     * It stops as soon as that patient leaves, though staff stay, and when the patient does not arrive in time.
     */
    patientId?: string;

    /** In a station: how long to wait for the patient after the bot joined. Defaults to 60 seconds. */
    patientWaitMs?: number;
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
     * Returns the participants with a verified identity, grouped by identity, in the order each identity first
     * joined.
     *
     * @returns {IIdentitySummary[]}
     */
    identities: () => IIdentitySummary[];

    /**
     * Returns the participants so far, in the order they first joined, with when they joined and left.
     *
     * @returns {IParticipant[]}
     */
    participants: () => IParticipant[];

    /**
     * Tells whether the station's patient was ever in the room. Always false outside a station.
     *
     * @returns {boolean}
     */
    patientArrived: () => boolean;

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
export const DEFAULT_PATIENT_WAIT_MS = 60 * 1000;

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
    'first_join': 'no_one_joined',
    'patient_arrival': 'patient_did_not_arrive'
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
    const patientWaitMs = options.patientWaitMs ?? DEFAULT_PATIENT_WAIT_MS;

    /** The endpoints of the station's patient, once they have arrived. */
    const patientEndpoints = new Set<string>();
    let patientArrived = false;
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

    /** The participants the bot has found in the room since it was interrupted. */
    const seenSinceInterruption = new Set<string>();

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
     * Records that a participant left.
     *
     * @param {Date} at - When.
     * @param {string} endpointId - The participant.
     * @returns {ILifecycleResult}
     */
    function leave(at: Date, endpointId: string): ILifecycleResult {
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

    /**
     * Records that a participant left, and, if it was the station's patient, stops the consultation.
     *
     * @param {Date} at - When.
     * @param {string} endpointId - The participant.
     * @returns {ILifecycleResult}
     */
    function leaveAndCheckPatient(at: Date, endpointId: string): ILifecycleResult {
        const left = leave(at, endpointId);

        if (!patientEndpoints.has(endpointId)) {
            return left;
        }

        const stopping = stop(at, 'patient_left');

        return {
            commands: [ ...left.commands, ...stopping.commands ],
            entries: [ ...left.entries, ...stopping.entries ]
        };
    }

    /**
     * Ends the current interruption: closes its gap, and records that every participant the relaunched bot did not
     * find in the room left during it. The bot learns that only now, so that is when they are recorded as leaving.
     *
     * @param {Date} at - When the bot resumed.
     * @returns {ILifecycleResult}
     */
    function resume(at: Date): ILifecycleResult {
        if (!interruptedAt) {
            return nothing();
        }

        const result: ILifecycleResult = { entries: [ { at, type: 'bot_resumed' }, ...closeGap(at) ], commands: [] };

        for (const endpointId of [ ...humans, ...hidden ]) {
            if (!seenSinceInterruption.has(endpointId) && !stopped) {
                const left = leaveAndCheckPatient(at, endpointId);

                result.entries.push(...left.entries);
                result.commands.push(...left.commands);
            }
        }
        seenSinceInterruption.clear();

        // A bot that never joined before waits for the first human from now on.
        const anyoneJoined = [ ...participants.values() ].some(p => !p.hidden);

        if (!anyoneJoined && !activeTimers.has('first_join')) {
            result.commands.push(startTimer('first_join', firstJoinMs));
        }

        return result;
    }

    /**
     * Ends every track still recorded.
     *
     * @param {Date} at - When.
     * @returns {TimelineEntry[]} Their stop entries.
     */
    function stopTracks(at: Date): TimelineEntry[] {
        const entries: TimelineEntry[] = [ ...openTracks.values() ].map(track => {
            track.stop = at;

            return { at, file: track.file, type: 'track_stopped' };
        });

        openTracks.clear();

        return entries;
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

        return {
            entries: [ ...closeGap(at), ...stopTracks(at), { at, reason, type: 'stopped' } ],
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
            case 'waiting_for_host':
            case 'bot_joined': {
                const waitForFirstJoin = !humans.size && !activeTimers.has('first_join');
                const waitForPatient = options.patientId !== undefined && !patientArrived
                    && !activeTimers.has('patient_arrival');

                return {
                    entries: [
                        event.type === 'bot_joined'
                            ? { at: event.at, meetingId: event.meetingId, type: 'bot_joined' }
                            : { at: event.at, type: 'waiting_for_host' }
                    ],
                    commands: [
                        ...waitForFirstJoin ? [ startTimer('first_join', firstJoinMs) ] : [],
                        ...waitForPatient ? [ startTimer('patient_arrival', patientWaitMs) ] : []
                    ]
                };
            }
            case 'participant_joined': {
                const { at, displayName, endpointId, identity, role } = event;

                if (interruptedAt) {
                    seenSinceInterruption.add(endpointId);

                    // Still in the room from before the interruption: not a new join.
                    if (humans.has(endpointId) || hidden.has(endpointId)) {
                        return nothing();
                    }
                }

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

                const isStationPatient = options.patientId !== undefined && identity?.id === options.patientId;

                if (isStationPatient) {
                    patientArrived = true;
                    patientEndpoints.add(endpointId);
                }

                if (role === 'staff') {
                    const visit = { displayName, end: undefined, endpointId, identity, start: at };

                    visits.push(visit);
                    openVisits.set(endpointId, visit);
                }

                return {
                    entries: [ { at, displayName, endpointId, identity, role, type: 'participant_joined' } ],
                    commands: [
                        ...cancelTimer('first_join'),
                        ...cancelTimer('empty_room'),
                        ...isStationPatient ? cancelTimer('patient_arrival') : []
                    ]
                };
            }
            case 'participant_left':
                return leaveAndCheckPatient(event.at, event.endpointId);
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
                seenSinceInterruption.clear();

                // The bot's recorders went with it.
                return {
                    entries: [ { at: event.at, type: 'bot_interrupted' }, ...stopTracks(event.at) ],
                    commands: []
                };
            case 'bot_resumed':
                return resume(event.at);
            case 'room_destroyed':
                return stop(event.at, 'room_destroyed');
            case 'kicked':
                return stop(event.at, 'kicked');
            case 'stop_requested':
                return stop(event.at, 'stop_requested');
            case 'shutdown':
                return stop(event.at, 'shutdown');
            case 'bot_failed':
                return stop(event.at, 'bot_failed');
            case 'timer_fired':
                if (!activeTimers.delete(event.timer)) {
                    return nothing();
                }

                return stop(event.at, TIMER_STOP_REASONS[event.timer]);
            }
        },

        identities() {
            const summaries = new Map<string, IIdentitySummary>();
            const byEndpoint = new Map<string, IIdentitySummary>();

            for (const { endpointId, hidden: isHidden, identity, role } of participants.values()) {
                if (!identity || isHidden) {
                    continue;
                }

                let summary = summaries.get(identity.id);

                if (!summary) {
                    summary = { endpointIds: [], files: [], identity: { ...identity }, role };
                    summaries.set(identity.id, summary);
                }
                summary.endpointIds.push(endpointId);
                byEndpoint.set(endpointId, summary);
            }

            for (const track of tracks) {
                byEndpoint.get(track.endpointId)?.files.push(track.file);
            }

            return [ ...summaries.values() ];
        },

        patientArrived() {
            return patientArrived;
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
