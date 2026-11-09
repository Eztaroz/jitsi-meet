/**
 * The coordinator service: applies the rules module's events one at a time, carries out the commands it returns, and
 * feeds the outcomes back as events. It owns the timers and the polling; the move side effects are in `moveEffects.ts`.
 */
import { randomUUID } from 'node:crypto';

import { type IAuditEntry, moveEntry, stageEntry } from './audit.ts';
import { log } from './log.ts';
import { nextMidnight } from './midnight.ts';
import { MoveEffects } from './moveEffects.ts';
import { allStages, findPathway, resolvePathway, stageName, strandedStages } from './pathways.ts';
import type { Prosody } from './prosody.ts';
import type { RecorderBot } from './recorderBot.ts';
import { backendSafeRoomName } from './roomName.ts';
import { type ILayout, type IRoleMarkers, type IRoom, type IStage, describeRooms } from './rooms.ts';
import {
    type Command,
    type IEncounter,
    type IMove,
    type IRoomView,
    type IState,
    type IStep,
    type RulesEvent,
    type Stage,
    learnStaffStations,
    queues,
    step
} from './rules.ts';
import { type IMoveRecord, type Store, newMoveRecord } from './store.ts';
import { type ISurvey, type ISurveyAnswers, placeSurvey, surveysCsv } from './surveys.ts';
import { type ITeam, describeTeams, stationsAt } from './teams.ts';

/**
 * The states of a move that is under way: it has no audit entry until it ends. `preparing` is a move from when patients
 * were moved, which is failed on resume.
 */
const ACTIVE_MOVE = new Set([ 'counting_down', 'preparing' ]);
const POLL_MS = 1000;

/**
 * Where the patients whose own room is known were seen in those rooms.
 *
 * @param {IState} state - The state.
 * @param {IRoomView[]} rooms - The rooms.
 * @returns {Record<string, string>} The room by verified identity id.
 */
function seenPatientRooms(state: IState, rooms: IRoomView[]): Record<string, string> {
    const seen: Record<string, string> = {};

    for (const room of rooms) {
        if (room.kind !== undefined && room.kind !== 'patient') {
            continue;
        }
        for (const o of room.occupants) {
            if (o.role === 'patient' && o.identity?.id && state.patientRooms[o.identity.id] === room.name) {
                seen[o.identity.id] = room.name;
            }
        }
    }

    return seen;
}

/**
 * Where the staff whose station is known were seen in that station's lounge.
 *
 * @param {IState} state - The state.
 * @param {IRoomView[]} rooms - The rooms.
 * @returns {Record<string, string>} The station by verified identity id.
 */
function seenStaffStations(state: IState, rooms: IRoomView[]): Record<string, string> {
    const seen: Record<string, string> = {};

    for (const room of rooms) {
        if (room.kind !== 'lounge' || !room.station) {
            continue;
        }
        for (const o of room.occupants) {
            if (o.role === 'staff' && o.identity?.id && state.staffStations[o.identity.id] === room.station) {
                seen[o.identity.id] = room.station;
            }
        }
    }

    return seen;
}

export class CoordinatorService {
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

    /** What is kept about each move beside the rules state: who asked, whether it is audited, its deadlines. */
    private readonly _records: Map<string, IMoveRecord>;

    /** The running timers of the moves, by move id and timer. */
    private readonly _timers = new Map<string, NodeJS.Timeout>();
    private _retention?: NodeJS.Timeout;

    private readonly _effects: MoveEffects;
    private _midnight?: NodeJS.Timeout;
    private _poll?: NodeJS.Timeout;
    private _queue: Promise<unknown> = Promise.resolve();
    private _state: IState;

    /**
     * Creates the service.
     *
     * @param {Object} opts - Its collaborators and settings.
     */
    constructor(opts: CoordinatorService['_opts']) {
        this._opts = opts;
        this._state = opts.store.load();

        // A stage that still holds open encounters cannot be taken out of the configuration (ADR 0013).
        const stranded = strandedStages(opts.layout, this._state.encounters);

        if (stranded.length) {
            throw new Error('the configuration removes a stage that still holds open encounters: '
                + stranded.map(s => `stage "${s.stage}" holds ${s.count} open encounter${s.count === 1 ? '' : 's'}`).join(', '));
        }
        this._records = opts.store.loadMoveRecords();
        this._effects = new MoveEffects(opts, {
            failSend: moveId => this._commit(step(this._state, {
                at: new Date(), moveId, reason: 'could_not_send_move', type: 'move_failed'
            }).state)
        });
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
     * Reads the rooms from Prosody, with the lounges nobody is in. Each staff member carries their station: the one
     * whose lounge they are in, or, in a patient's room, the one whose lounge they were last seen in (ADR 0011).
     *
     * @returns {Promise<IRoom[]>}
     */
    async rooms(): Promise<IRoom[]> {
        const rooms = describeRooms(await this._opts.prosody.rooms(), this._opts.roleMarkers, this._opts.layout);
        const { staffStations } = learnStaffStations(this._state, rooms);

        if (staffStations !== this._state.staffStations) {
            // Kept after whatever is being applied now, as every change of the state is.
            this._serial(async () => this._commit(learnStaffStations(this._state, rooms)))
                .catch(error => log.error('could not keep the stations of staff', { error: (error as Error).name }));
        }

        return rooms.map(room => {
            const encounter = room.kind === 'patient'
                ? this._state.encounters.find(e => e.stage !== 'done'
                    && backendSafeRoomName(e.hn) === backendSafeRoomName(room.name))
                : undefined;
            const occupants = room.kind !== 'patient' ? room.occupants : room.occupants.map(o => {
                const station = o.role === 'staff' && o.identity?.id ? staffStations[o.identity.id] : undefined;

                return station === undefined ? o : { ...o, station };
            });

            return encounter ? { ...room, encounterId: encounter.id, occupants } : { ...room, occupants };
        });
    }

    /**
     * Starts an encounter, or returns the open one. Nothing is saved unless the recorder bot accepted the room. The
     * encounter follows its clinic's pathway, else its center's, else the default one (ADR 0013).
     *
     * @param {string} hn - The patient's HN.
     * @param {Object} [where] - What the hospital's system knows of the attendance.
     * @param {string} [where.center] - The center; refused when it is not configured.
     * @param {string} [where.clinic] - The clinic; refused when its center does not have it.
     * @param {string} [where.visitNumber] - The hospital system's number for the visit.
     * @returns {Promise<IStep>}
     */
    startEncounter(hn: string, where: { center?: string; clinic?: string; visitNumber?: string; } = {}): Promise<IStep> {
        return this._serial(async () => {
            const resolved = resolvePathway(this._opts.layout, where);

            if ('reason' in resolved) {
                return { commands: [], refused: resolved.reason, state: this._state };
            }

            const result = step(this._state, {
                at: new Date(),
                center: resolved.center,
                clinic: resolved.clinic,
                hn,
                pathway: resolved.pathway.id,
                type: 'start_encounter',
                visitNumber: where.visitNumber
            });

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
            const encounter = this._state.encounters.find(e => e.id === encounterId);
            const from = encounter?.stage;
            const pathwayStages = encounter && (findPathway(this._opts.layout, encounter.pathway)?.stages ?? []).map(s => s.id);
            const result = step(this._state, { at, encounterId, pathwayStages, stage, type: 'change_stage' });

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
     * Keeps a patient's satisfaction survey, tied to their HN and encounter as far as the service knows them.
     *
     * @param {string} identityId - The patient's verified identity id.
     * @param {ISurveyAnswers} answers - What they answered, and the room they left.
     * @returns {ISurvey}
     */
    addSurvey(identityId: string, answers: ISurveyAnswers): ISurvey {
        const { room, ...rest } = answers;
        const survey: ISurvey = {
            ...rest,
            ...placeSurvey({ identityId, layout: this._opts.layout, room, state: this._state }),
            id: randomUUID(),
            submittedAt: new Date()
        };

        this._opts.store.addSurvey(survey);

        return survey;
    }

    /**
     * Writes the report of the surveys submitted in a period, and says in the audit log who exported it: it names
     * patients by their HN.
     *
     * @param {Date} from - The start of the period.
     * @param {Date} to - The end of the period.
     * @param {string} issuer - Who asks: `system`.
     * @returns {string} CSV.
     */
    surveyReport(from: Date, to: Date, issuer: string): string {
        const surveys = this._opts.store.surveys(from, to);

        this._audit({ at: new Date(), count: surveys.length, issuer, kind: 'survey_export', outcome: 'ok' });

        return surveysCsv(surveys, this._opts.timeZone);
    }

    /**
     * The queues of the stages: the open encounters in each, the longest-waiting first.
     *
     * @param {IRoom[]} [rooms] - The rooms now; with them, an encounter whose room holds a station's staff names the
     * station in `at`, which is where the patient is, rather than in the queue.
     * @returns {Queues}
     */
    queues(rooms?: IRoom[]) {
        const result = queues(this._state, new Date(), this.stages().map(s => s.id));

        if (!rooms) {
            return result;
        }

        const at = stationsAt(this.teams(rooms));

        return Object.fromEntries(Object.entries(result).map(([ stage, entries ]) =>
            [ stage, entries.map(e => at[e.encounterId] ? { ...e, at: at[e.encounterId] } : e) ]));
    }

    /**
     * The stations as teams: the free staff in each lounge, and the busy staff with the patient they are with.
     *
     * @param {IRoom[]} rooms - The rooms now, from `rooms()`.
     * @returns {ITeam[]}
     */
    teams(rooms: IRoom[]): ITeam[] {
        return describeTeams(this._opts.layout, rooms);
    }

    /**
     * The stages of the configured pathways, each once, with their names: what the coordinator's screen draws.
     *
     * @returns {IStage[]}
     */
    stages(): IStage[] {
        return allStages(this._opts.layout);
    }

    /**
     * Describes an encounter for a reader: each stage of its history with its name, which is its id once the
     * configuration no longer has the stage.
     *
     * @param {string} encounterId - The encounter.
     * @returns {Object|undefined} Undefined when there is no such encounter.
     */
    describeEncounter(encounterId: string): (Omit<IEncounter, 'history'> & {
        history: { at: Date; name: string; stage: string; }[];
        stageName: string;
    }) | undefined {
        const encounter = this._state.encounters.find(e => e.id === encounterId);

        if (!encounter) {
            return undefined;
        }

        const name = (stage: string) => stageName(this._opts.layout, encounter.pathway, stage);

        return {
            ...encounter,
            history: encounter.history.map(h => ({ ...h, name: name(h.stage) })),
            stageName: name(encounter.stage)
        };
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

            this._records.set(moveId, newMoveRecord(issuer));

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
     * Picks up the moves that were under way when the service last stopped: restarts each pending timer for the time
     * left, and settles at once, the way a normal timeout does, any whose deadline passed while the service was down.
     * A move that was preparing a patient's destination, from when patients were moved, fails (ADR 0011). Call it once
     * after creating the service.
     *
     * @returns {Promise<void>}
     */
    resume(): Promise<void> {
        return this._serial(async () => {
            for (const move of this._state.moves.filter(m => m.state === 'preparing')) {
                await this._apply({ at: new Date(), moveId: move.id, reason: 'patient_moves_retired', type: 'move_failed' }, []);
            }

            const active = this._state.moves.filter(m => ACTIVE_MOVE.has(m.state));

            if (active.length) {
                // A participant may have arrived while the service was down.
                const rooms = await this.rooms().catch(() => undefined);

                if (rooms) {
                    await this._apply({ at: new Date(), rooms, type: 'rooms_snapshot' }, rooms);
                }
            }
            for (const saved of active) {
                const move = this._state.moves.find(m => m.id === saved.id);

                if (move?.state !== 'counting_down') {
                    continue;
                }

                const deadline = this._records.get(move.id)?.deadlines.move_arrival;

                if (!deadline || deadline.getTime() <= Date.now()) {
                    await this._apply({ at: new Date(), moveId: move.id, timer: 'move_arrival', type: 'timer_fired' }, []);
                    continue;
                }
                this._startTimer(move.id, 'move_arrival', deadline);
            }
            if (this._state.moves.some(m => ACTIVE_MOVE.has(m.state))) {
                this._ensurePolling();
            }
        });
    }

    /**
     * Stops everything that runs on its own: the sweep, the end of the day and the polling.
     *
     * @returns {void}
     */
    stop(): void {
        clearInterval(this._retention);
        clearTimeout(this._midnight);
        for (const timer of this._timers.values()) {
            clearTimeout(timer);
        }
        this._timers.clear();
        this._stopPolling();
    }

    /**
     * Stops polling the rooms, once no move is under way. The sweep and the end of the day go on.
     *
     * @returns {void}
     */
    private _stopPolling(): void {
        clearInterval(this._poll);
        this._poll = undefined;
    }

    /**
     * Applies an event and carries out its commands.
     *
     * @param {RulesEvent} event - The event.
     * @param {IRoom[]} rooms - The rooms at the time, for the commands that need the participant's identity.
     * @param {Function} newId - Makes the opaque id of a new move.
     * @returns {Promise<IStep>}
     */
    private async _apply(event: RulesEvent, rooms: IRoom[], newId?: () => string): Promise<IStep> {
        const result = step(this._state, event, newId);

        this._commit(result.state);
        if (event.type === 'rooms_snapshot' || event.type === 'request_move') {
            this._opts.store.touchPatientRooms(seenPatientRooms(this._state, event.rooms));
            this._opts.store.touchStaffStations(seenStaffStations(this._state, event.rooms));
        }
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
            this._state = state;

            // The entries and the `audited` flags are saved in one transaction, so that a crash cannot leave an entry
            // that a restart would write again.
            const { entries, records } = this._endedMoves();

            this._opts.store.save(this._state, records, entries);
            for (const [ id, record ] of records) {
                this._records.set(id, record);
            }
        }
    }

    /**
     * Saves the state and what is kept about each move.
     *
     * @returns {void}
     */
    private _persist(): void {
        this._opts.store.save(this._state, this._records);
    }

    /**
     * Starts the timer of a move to fire at a deadline, and keeps the deadline so that a restart can resume it.
     *
     * @param {string} moveId - The move.
     * @param {string} timer - Which timer.
     * @param {Date} deadline - When it fires.
     * @returns {void}
     */
    private _startTimer(moveId: string, timer: 'move_arrival', deadline: Date): void {
        const key = `${moveId}:${timer}`;
        const record = this._records.get(moveId) ?? newMoveRecord();

        this._records.set(moveId, { ...record, deadlines: { ...record.deadlines, [timer]: deadline } });
        this._persist();
        clearTimeout(this._timers.get(key));

        const handle = setTimeout(() => {
            this._timers.delete(key);
            this._serial(() => this._apply({
                at: new Date(), moveId, timer, type: 'timer_fired'
            }, [])).catch(error => log.error('a timer failed', { error: (error as Error).name }));
        }, Math.max(0, deadline.getTime() - Date.now()));

        handle.unref();
        this._timers.set(key, handle);
    }

    /**
     * Finds the moves that have ended and have no audit entry yet.
     *
     * @returns {Object} Their audit entries, and the records to keep once the entries are saved.
     */
    private _endedMoves(): { entries: IAuditEntry[]; records: Map<string, IMoveRecord>; } {
        const entries: IAuditEntry[] = [];
        const records = new Map(this._records);

        for (const move of this._state.moves) {
            const record = records.get(move.id) ?? newMoveRecord();

            if (!ACTIVE_MOVE.has(move.state) && !record.audited) {
                entries.push(moveEntry(move, {
                    at: new Date(),
                    issuer: record.issuer,
                    key: this._opts.auditKey,
                    layout: this._opts.layout
                }));
                records.set(move.id, { ...record, audited: true, deadlines: {} });
            }
        }

        return { entries, records };
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
                moves: this._state.moves.filter(m => m.startedAt >= cutoff),
                patientRooms: this._opts.store.patientRooms(),
                staffStations: this._opts.store.staffStations()
            };
            for (const id of this._records.keys()) {
                if (!this._state.moves.some(m => m.id === id)) {
                    this._records.delete(id);
                }
            }
            if (Object.values(removed).some(Boolean)) {
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
            this._startTimer(command.moveId, command.timer, new Date(Date.now() + command.afterMs));
            break;
        case 'send_move':
            await this._effects.sendMove(command, rooms);
            break;
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
                this._stopPolling();

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
