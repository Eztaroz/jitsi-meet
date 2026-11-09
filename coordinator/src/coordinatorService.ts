/**
 * The coordinator service: applies the rules module's events one at a time, carries out the commands it returns, and
 * feeds the outcomes back as events. It owns the timers and the polling; the move side effects are in `moveEffects.ts`.
 */
import { randomUUID } from 'node:crypto';

import { type IAuditEntry, doctorEntry, moveEntry, questionnaireEntry, stageEntry, videoEntry } from './audit.ts';
import { signToken } from './jwt.ts';
import { log } from './log.ts';
import { nextMidnight } from './midnight.ts';
import { MoveEffects } from './moveEffects.ts';
import { DONE, allStages, findPathway, resolvePathway, stageName, strandedStages } from './pathways.ts';
import type { Prosody } from './prosody.ts';
import {
    type IPatientQuestionnaire,
    type IQuestionnaire,
    type ISentQuestionnaire,
    parseAnswers
} from './questionnaires.ts';
import type { RecorderBot } from './recorderBot.ts';
import { backendSafeRoomName } from './roomName.ts';
import {
    type ILayout,
    type IOccupant,
    type IRoleMarkers,
    type IRoom,
    type IStage,
    type IVideo,
    describeRooms,
    sameRoom,
    stationsOf
} from './rooms.ts';
import {
    type Command,
    type IEncounter,
    type IExaminationQueues,
    type IMove,
    type IQueueEntry,
    type IRoomView,
    type IState,
    type IStep,
    type RulesEvent,
    type Stage,
    examinationQueues,
    learnStaffStations,
    queues,
    step
} from './rules.ts';
import { type IMoveRecord, type Store, newMoveRecord } from './store.ts';
import { type ISurvey, type ISurveyAnswers, placeSurvey, surveysCsv } from './surveys.ts';
import { type ITeam, describeTeams, stationsAt } from './teams.ts';
import { destinationClaims } from './tokens.ts';
import { type IVideoPlayer, VideoPlayerUnavailableError } from './videoPlayer.ts';

/** How long the token a video player joins a room with lasts: it is used at once. */
const VIDEO_PLAYER_TOKEN_MS = 5 * 60_000;

/** The identity the video player joins with. */
const VIDEO_PLAYER_IDENTITY = { id: 'video-player', name: 'Video player' };

/** Why a video could not be played or stopped. */
export type VideoRefusal = 'already_playing' | 'encounter_closed' | 'no_video' | 'not_in_patients_room' | 'not_playing'
    | 'stage_not_in_pathway' | 'unknown_encounter' | 'unknown_video' | 'video_player_unavailable';

/** A video that is playing in a patient's room. */
interface IPlayingVideo {
    encounterId: string;
    room: string;

    /** The staff in the room when it started; only those who join later stop it. */
    staffAtStart: Set<string>;
    videoId: string;
}

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

/** Where a staff member is, as `GET /staff/me` tells their client. */
export interface IStaffContext {
    /** The video the encounter gets at its current stage: its own choice, else the stage's default. */
    chosenVideo?: string;

    encounter?: { id: string; stage: string; stageName: string; };
    /** The stages the staff member can put the encounter in: every stage of its pathway but `done`. */
    stages?: { id: string; name: string; }[];

    station?: string;

    /** Whether a video plays in the patient's room now. */
    videoPlaying?: boolean;

    /** The waiting videos staff can choose from. */
    videos?: { id: string; title: string; }[];
    where: 'lounge' | 'nowhere' | 'patients_room';
}

export interface IStaffStageResult {
    encounter?: IEncounter;

    /** The staff member's move back to their lounge, if one was asked for. */
    move?: IMove;
    moved: boolean;
    refused?: 'done_is_not_for_staff' | 'encounter_closed' | 'not_in_patients_room' | 'stage_not_in_pathway'
        | 'unknown_encounter';
}

/**
 * Finds a staff member in the rooms, by verified identity id.
 *
 * @param {IRoom[]} rooms - The rooms.
 * @param {string} id - The staff member's verified identity id.
 * @returns {Object|undefined} The room they are in and their occupant entry.
 */
function findStaff(rooms: IRoom[], id: string): { occupant: IOccupant; room: IRoom; } | undefined {
    for (const room of rooms) {
        const occupant = room.occupants.find(o => o.role === 'staff' && o.identity?.id === id);

        if (occupant) {
            return { occupant, room };
        }
    }

    return undefined;
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

        /** Where the web server hosts the videos' files; with the video player, it turns the videos on. */
        videoBaseUrl?: string;
        videoPlayer?: IVideoPlayer;
    };

    /** What is kept about each move beside the rules state: who asked, whether it is audited, its deadlines. */
    private readonly _records: Map<string, IMoveRecord>;

    /** The running timers of the moves, by move id and timer. */
    private readonly _timers = new Map<string, NodeJS.Timeout>();
    private _retention?: NodeJS.Timeout;

    /** The videos playing now, by encounter. Not kept over a restart: the video player ends them by itself. */
    private readonly _videos = new Map<string, IPlayingVideo>();
    private _videoWatch?: NodeJS.Timeout;

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
     * The health questionnaires the deployment offers.
     *
     * @returns {IQuestionnaire[]}
     */
    questionnaireCatalogue(): IQuestionnaire[] {
        return this._opts.layout.questionnaires ?? [];
    }

    /**
     * The waiting videos of the catalogue, which an encounter's video can be chosen from.
     *
     * @returns {IVideo[]}
     */
    videoCatalogue(): IVideo[] {
        return this._opts.layout.videos ?? [];
    }

    /**
     * The health questionnaires sent to a patient during an encounter, oldest first, with their answers. Only that
     * encounter's: another encounter of the same patient keeps its own.
     *
     * @param {string} encounterId - The encounter.
     * @returns {ISentQuestionnaire[]|undefined} Undefined when there is no such encounter.
     */
    questionnairesOf(encounterId: string): ISentQuestionnaire[] | undefined {
        const encounter = this._state.encounters.find(e => e.id === encounterId);

        return encounter && (encounter.questionnaires ?? []);
    }

    /**
     * Sends a health questionnaire from the catalogue to the patient of an open encounter, at any stage. Several can be
     * sent to one encounter; each is kept apart. The sending is audited.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} questionnaireId - The questionnaire's id in the catalogue.
     * @param {string} issuer - Who sends: `system`, or a coordinator's or staff member's verified identity id.
     * @returns {Promise<Object>} The sending, or why it was refused.
     */
    sendQuestionnaire(encounterId: string, questionnaireId: string, issuer: string): Promise<{
        refused?: 'encounter_closed' | 'unknown_encounter' | 'unknown_questionnaire';
        sent?: ISentQuestionnaire;
    }> {
        return this._serial(async () => {
            const at = new Date();
            const encounter = this._state.encounters.find(e => e.id === encounterId);
            const questionnaire = this.questionnaireCatalogue().find(q => q.id === questionnaireId);
            let refused: 'encounter_closed' | 'unknown_encounter' | 'unknown_questionnaire' | undefined;

            if (!encounter) {
                refused = 'unknown_encounter';
            } else if (encounter.stage === 'done') {
                refused = 'encounter_closed';
            } else if (!questionnaire) {
                refused = 'unknown_questionnaire';
            }
            if (refused || !encounter || !questionnaire) {
                this._audit(questionnaireEntry({
                    at, encounterId, issuer, outcome: 'refused', questionnaire: questionnaireId, reason: refused
                }));

                return { refused };
            }

            const room = await this._roomOf(encounter);
            const sent: ISentQuestionnaire = {
                id: randomUUID(),
                questionnaire: questionnaire.id,
                questions: questionnaire.questions,
                sentAt: at,
                sentBy: issuer,
                staffAtSend: (room?.occupants ?? []).filter(o => o.role === 'staff').map(o => o.endpointId),
                title: questionnaire.title
            };

            this._setQuestionnaires(encounter.id, [ ...encounter.questionnaires ?? [], sent ]);
            this._audit(questionnaireEntry({ at, encounterId, issuer, outcome: 'ok', questionnaire: questionnaire.id }));

            return { sent };
        });
    }

    /**
     * What a patient's client shows now: the oldest questionnaire sent to the patient's open encounter that they have
     * not answered and that no staff member has joined after. A questionnaire that staff joined after is closed, for
     * good: it holds nobody up.
     *
     * @param {string} identityId - The patient's verified identity id.
     * @returns {Promise<IPatientQuestionnaire|undefined>} Undefined when nothing is waiting for them.
     */
    pendingQuestionnaire(identityId: string): Promise<IPatientQuestionnaire | undefined> {
        return this._serial(async () => {
            const found = await this._questionnaireOf(identityId);
            const open = found?.encounter.questionnaires?.find(q => !q.answeredAt && !q.closedAt);

            return open && { id: open.id, questions: open.questions, title: open.title };
        });
    }

    /**
     * Keeps a patient's answers to a questionnaire that is waiting for them.
     *
     * @param {string} identityId - The patient's verified identity id.
     * @param {string} sentId - The id of the sending.
     * @param {unknown} answers - For each question, the index (0 or 1) of the choice.
     * @returns {Promise<Object>} Why it was refused, if it was.
     */
    answerQuestionnaire(identityId: string, sentId: string, answers: unknown): Promise<{
        refused?: 'invalid_answers' | 'unknown_questionnaire';
    }> {
        return this._serial(async () => {
            const found = await this._questionnaireOf(identityId);
            const sent = found?.encounter.questionnaires?.find(q => q.id === sentId && !q.answeredAt && !q.closedAt);

            if (!found || !sent) {
                return { refused: 'unknown_questionnaire' as const };
            }

            const parsed = parseAnswers(answers, sent.questions);

            if (!parsed) {
                return { refused: 'invalid_answers' as const };
            }
            this._setQuestionnaires(found.encounter.id, (found.encounter.questionnaires ?? [])
                .map(q => q === sent ? { ...q, answeredAt: new Date(), answers: parsed } : q));

            return {};
        });
    }

    /**
     * Finds the open encounter of a patient from where they are now, and closes the questionnaires that staff have
     * joined the room after.
     *
     * @param {string} identityId - The patient's verified identity id.
     * @returns {Promise<Object|undefined>} The encounter as it is after closing; undefined when the patient is in no
     * patient's room that has an open encounter.
     */
    private async _questionnaireOf(identityId: string): Promise<{ encounter: IEncounter; } | undefined> {
        const rooms = describeRooms(await this._opts.prosody.rooms(), this._opts.roleMarkers, this._opts.layout);
        const room = rooms.find(r => r.kind === 'patient'
            && r.occupants.some(o => o.role === 'patient' && o.identity?.id === identityId));
        const encounter = room && this._state.encounters.find(e => e.stage !== 'done' && sameRoom(e.hn, room.name));

        if (!room || !encounter) {
            return undefined;
        }

        const staff = room.occupants.filter(o => o.role === 'staff').map(o => o.endpointId);
        const joined = (q: ISentQuestionnaire) => staff.some(s => !q.staffAtSend.includes(s));

        if (encounter.questionnaires?.some(q => !q.answeredAt && !q.closedAt && joined(q))) {
            const closedAt = new Date();

            this._setQuestionnaires(encounter.id, encounter.questionnaires
                .map(q => !q.answeredAt && !q.closedAt && joined(q) ? { ...q, closedAt } : q));
        }

        return { encounter: this._state.encounters.find(e => e.id === encounter.id) as IEncounter };
    }

    /**
     * Finds an encounter's room among the open rooms.
     *
     * @param {IEncounter} encounter - The encounter.
     * @returns {Promise<IRoom|undefined>}
     */
    private async _roomOf(encounter: IEncounter): Promise<IRoom | undefined> {
        const rooms = describeRooms(await this._opts.prosody.rooms(), this._opts.roleMarkers, this._opts.layout);

        return rooms.find(r => r.kind === 'patient' && sameRoom(r.name, encounter.hn));
    }

    /**
     * Replaces the questionnaires of an encounter and saves.
     *
     * @param {string} encounterId - The encounter.
     * @param {ISentQuestionnaire[]} questionnaires - Its questionnaires.
     * @returns {void}
     */
    private _setQuestionnaires(encounterId: string, questionnaires: ISentQuestionnaire[]): void {
        this._commit({
            ...this._state,
            encounters: this._state.encounters.map(e => e.id === encounterId ? { ...e, questionnaires } : e)
        });
    }

    /**
     * Sets, changes or takes away the doctor of an encounter.
     *
     * @param {string} encounterId - The encounter.
     * @param {string|null} doctor - A staff member's verified identity id; null takes the doctor away.
     * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
     * @returns {Promise<IStep>}
     */
    setDoctor(encounterId: string, doctor: string | null, issuer: string): Promise<IStep> {
        return this._serial(async () => {
            const at = new Date();
            const previousDoctor = this._state.encounters.find(e => e.id === encounterId)?.doctor;
            const result = step(this._state, { at, doctor, encounterId, type: 'set_doctor' });

            this._commit(result.state);
            this._audit(doctorEntry({
                at, doctor: doctor ?? undefined, encounterId, issuer, outcome: result.refused ? 'refused' : 'ok',
                previousDoctor, reason: result.refused
            }));

            return result;
        });
    }

    /**
     * Plays a waiting video once in an encounter's room: the video asked for, else the encounter's choice for its
     * current stage, else the stage's default. It stops when told to, when a staff member joins after it started, and at
     * its end.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
     * @param {string} [videoId] - A video of the catalogue; unset for the stage's default.
     * @returns {Promise<{ refused?: VideoRefusal; video?: string; }>}
     */
    playVideo(encounterId: string, issuer: string, videoId?: string): Promise<{ refused?: VideoRefusal; video?: string; }> {
        return this._serial(() => this._playVideo(encounterId, issuer, videoId));
    }

    /**
     * Plays a waiting video. Call it inside the serial queue.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} issuer - Who asked.
     * @param {string} [videoId] - A video of the catalogue; unset for the encounter's choice, else the stage's default.
     * @returns {Promise<{ refused?: VideoRefusal; video?: string; }>}
     */
    private async _playVideo(encounterId: string, issuer: string, videoId?: string): Promise<{ refused?: VideoRefusal; video?: string; }> {
        const { layout, videoBaseUrl, videoPlayer } = this._opts;
        const encounter = this._state.encounters.find(e => e.id === encounterId);
        const chosen = videoId ?? encounter?.videos?.[encounter.stage] ?? findPathway(layout, encounter?.pathway ?? '')
                ?.stages.find(s => s.id === encounter?.stage)?.defaultVideo;
        const video = chosen === undefined ? undefined : layout.videos?.find(v => v.id === chosen);
        const refuse = (refused: VideoRefusal) => {
            this._audit(videoEntry({
                action: 'play', at: new Date(), encounterId, issuer, outcome: 'refused', reason: refused, video: chosen
            }));

            return { refused };
        };

        if (!encounter) {
            return { refused: 'unknown_encounter' as const };
        }
        if (encounter.stage === 'done') {
            return refuse('encounter_closed');
        }
        if (chosen === undefined) {
            return refuse('no_video');
        }
        if (!video) {
            return refuse('unknown_video');
        }
        if (!videoPlayer || !videoBaseUrl) {
            return refuse('video_player_unavailable');
        }
        if (this._videos.has(encounterId)) {
            return refuse('already_playing');
        }

        const room = encounter.hn;
        const staffAtStart = new Set((await this.rooms()).find(r => r.kind === 'patient' && sameRoom(r.name, room))
                ?.occupants.filter(o => o.role === 'staff').map(o => o.endpointId));

        try {
            await videoPlayer.play({
                room,
                token: signToken({
                    claims: destinationClaims({
                        ...this._opts.token,
                        identity: VIDEO_PLAYER_IDENTITY,
                        lifetimeMs: VIDEO_PLAYER_TOKEN_MS,
                        markers: this._opts.roleMarkers,
                        now: new Date(),
                        role: 'video_player',
                        room
                    }),
                    ...this._opts.signingKey
                }),
                videoUrl: new URL(video.file, videoBaseUrl).href
            });
        } catch (error) {
            if (error instanceof VideoPlayerUnavailableError) {
                log.warn('could not play a video', { error: error.code });

                return refuse(error.code === 'already_playing' ? 'already_playing' : 'video_player_unavailable');
            }
            throw error;
        }
        this._videos.set(encounterId, { encounterId, room, staffAtStart, videoId: video.id });
        this._watchVideos();
        this._audit(videoEntry({ action: 'play', at: new Date(), encounterId, issuer, outcome: 'ok', video: video.id }));

        return { video: video.id };
    }

    /**
     * Stops the video playing in an encounter's room.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} issuer - Who asked: `system`, or a coordinator's verified identity id.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    stopVideo(encounterId: string, issuer: string): Promise<{ refused?: VideoRefusal; }> {
        return this._serial(() => this._stopVideo(encounterId, issuer));
    }

    /**
     * Stops the video playing in an encounter's room. Call it inside the serial queue.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} issuer - Who asked.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    private async _stopVideo(encounterId: string, issuer: string): Promise<{ refused?: VideoRefusal; }> {
        const playing = this._videos.get(encounterId);

        if (!playing) {
            this._audit(videoEntry({
                action: 'stop', at: new Date(), encounterId, issuer, outcome: 'refused', reason: 'not_playing'
            }));

            return { refused: 'not_playing' as const };
        }
        await this._endVideo(playing, issuer);

        return {};
    }

    /**
     * Chooses the waiting video an encounter gets at a stage, in place of the stage's default.
     *
     * @param {string} encounterId - The encounter.
     * @param {Stage} stage - A stage of the encounter's pathway.
     * @param {string} videoId - A video of the catalogue.
     * @param {string} issuer - Who asked: `system`, a coordinator's or a staff member's verified identity id.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    setVideo(encounterId: string, stage: Stage, videoId: string, issuer: string): Promise<{ refused?: VideoRefusal; }> {
        return this._serial(() => this._setVideo(encounterId, stage, videoId, issuer));
    }

    /**
     * Chooses a video. Call it inside the serial queue.
     *
     * @param {string} encounterId - The encounter.
     * @param {Stage} stage - The stage.
     * @param {string} videoId - The video.
     * @param {string} issuer - Who asked.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    private async _setVideo(encounterId: string, stage: Stage, videoId: string, issuer: string): Promise<{ refused?: VideoRefusal; }> {
        const { layout } = this._opts;
        const encounter = this._state.encounters.find(e => e.id === encounterId);
        const known = layout.videos?.some(v => v.id === videoId);
        const result = known ? step(this._state, {
            at: new Date(),
            encounterId,
            pathwayStages: (findPathway(layout, encounter?.pathway ?? '')?.stages ?? []).map(s => s.id),
            stage,
            type: 'set_video',
            video: videoId
        }) : undefined;
        const refused = result ? result.refused as VideoRefusal | undefined : 'unknown_video' as const;

        if (result) {
            this._commit(result.state);
        }
        if (encounter) {
            this._audit(videoEntry({
                action: 'choose', at: new Date(), encounterId, issuer, outcome: refused ? 'refused' : 'ok', reason: refused,
                stage, video: videoId
            }));
        }

        return refused ? { refused } : {};
    }

    /**
     * Checks that a staff member is in an encounter's own room. A refusal is audited with the staff member.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} action - What the staff member asked, for the audit.
     * @param {string} staffId - The staff member's verified identity id.
     * @returns {Promise<VideoRefusal|undefined>} Why not, or undefined when they are.
     */
    private async _staffVideoRefusal(encounterId: string, action: 'choose' | 'play' | 'stop', staffId: string): Promise<VideoRefusal | undefined> {
        if (!this._state.encounters.some(e => e.id === encounterId)) {
            return 'unknown_encounter';
        }

        const here = findStaff(await this.rooms(), staffId);

        if (here?.room.kind === 'patient' && here.room.encounterId === encounterId) {
            return undefined;
        }
        this._audit(videoEntry({
            action, at: new Date(), encounterId, issuer: staffId, outcome: 'refused', reason: 'not_in_patients_room'
        }));

        return 'not_in_patients_room';
    }

    /**
     * Chooses an encounter's video for a stage on a staff member's request: only from inside the patient's own room.
     *
     * @param {string} encounterId - The encounter.
     * @param {Stage} stage - The stage.
     * @param {string} videoId - The video.
     * @param {Object} staff - The staff member, by verified identity.
     * @param {string} staff.id - The verified identity id.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    staffSetVideo(encounterId: string, stage: Stage, videoId: string, staff: { id: string; }): Promise<{ refused?: VideoRefusal; }> {
        return this._serial(async () => {
            const refused = await this._staffVideoRefusal(encounterId, 'choose', staff.id);

            return refused ? { refused } : this._setVideo(encounterId, stage, videoId, staff.id);
        });
    }

    /**
     * Plays an encounter's video on a staff member's request: only from inside the patient's own room. The video keeps
     * playing after the staff member leaves.
     *
     * @param {string} encounterId - The encounter.
     * @param {Object} staff - The staff member, by verified identity.
     * @param {string} staff.id - The verified identity id.
     * @returns {Promise<{ refused?: VideoRefusal; video?: string; }>}
     */
    staffPlayVideo(encounterId: string, staff: { id: string; }): Promise<{ refused?: VideoRefusal; video?: string; }> {
        return this._serial(async () => {
            const refused = await this._staffVideoRefusal(encounterId, 'play', staff.id);

            return refused ? { refused } : this._playVideo(encounterId, staff.id);
        });
    }

    /**
     * Stops an encounter's video on a staff member's request: only from inside the patient's own room.
     *
     * @param {string} encounterId - The encounter.
     * @param {Object} staff - The staff member, by verified identity.
     * @param {string} staff.id - The verified identity id.
     * @returns {Promise<{ refused?: VideoRefusal; }>}
     */
    staffStopVideo(encounterId: string, staff: { id: string; }): Promise<{ refused?: VideoRefusal; }> {
        return this._serial(async () => {
            const refused = await this._staffVideoRefusal(encounterId, 'stop', staff.id);

            return refused ? { refused } : this._stopVideo(encounterId, staff.id);
        });
    }

    /**
     * The videos playing now.
     *
     * @returns {{ encounterId: string; video: string; }[]}
     */
    playingVideos(): { encounterId: string; video: string; }[] {
        return [ ...this._videos.values() ].map(v => ({ encounterId: v.encounterId, video: v.videoId }));
    }

    /**
     * Stops a video and audits who did.
     *
     * @param {IPlayingVideo} playing - The video.
     * @param {string} issuer - Who stopped it.
     * @param {string} [reason] - Why, when it was not asked for.
     * @returns {Promise<void>}
     */
    private async _endVideo(playing: IPlayingVideo, issuer: string, reason?: string): Promise<void> {
        this._videos.delete(playing.encounterId);
        try {
            await this._opts.videoPlayer?.stop(playing.room);
        } catch (error) {
            log.warn('could not stop a video', { error: error instanceof VideoPlayerUnavailableError ? error.code : 'unknown' });
        }
        this._audit(videoEntry({
            action: 'stop', at: new Date(), encounterId: playing.encounterId, issuer, outcome: 'ok', reason, video: playing.videoId
        }));
    }

    /**
     * Watches the playing videos while there are any: one that has ended is forgotten, and one is stopped when a staff
     * member joins its room after it started.
     *
     * @returns {void}
     */
    private _watchVideos(): void {
        if (this._videoWatch) {
            return;
        }
        this._videoWatch = setInterval(() => {
            if (!this._videos.size) {
                clearInterval(this._videoWatch);
                this._videoWatch = undefined;

                return;
            }
            this._serial(async () => {
                const [ rooms, live ] = await Promise.all([ this.rooms(), this._opts.videoPlayer?.playingRooms() ]);

                for (const playing of [ ...this._videos.values() ]) {
                    if (!live?.some(r => sameRoom(r, playing.room))) {
                        this._videos.delete(playing.encounterId);
                        continue;
                    }

                    const joined = rooms.find(r => r.kind === 'patient' && sameRoom(r.name, playing.room))?.occupants
                        .some(o => o.role === 'staff' && !playing.staffAtStart.has(o.endpointId));

                    if (joined) {
                        await this._endVideo(playing, 'system', 'staff_joined');
                    }
                }
            }).catch(() => undefined);
        }, POLL_MS);
        this._videoWatch.unref();
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
     * Examination's queue split by doctor, with the patients who have no doctor yet. Each entry names the patient's HN,
     * for the readers that are allowed to see it.
     *
     * @returns {Object}
     */
    examinationQueues(): { doctors: Record<string, (IQueueEntry & { hn?: string; })[]>;
        unassigned: (IQueueEntry & { hn?: string; })[]; } {
        const split: IExaminationQueues = examinationQueues(this._state, new Date());
        const named = (entries: IQueueEntry[]) => entries.map(e => ({
            ...e, hn: this._state.encounters.find(x => x.id === e.encounterId)?.hn
        }));

        return {
            doctors: Object.fromEntries(Object.entries(split.doctors).map(([ doctor, entries ]) => [ doctor, named(entries) ])),
            unassigned: named(split.unassigned)
        };
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
        return this._serial(() => this._startMove(request, issuer));
    }

    /**
     * Where a staff member is now, for their client: in a station's lounge, in a patient's room with the encounter
     * and the stages they can pick, or nowhere the service knows.
     *
     * @param {Object} staff - The staff member, by verified identity.
     * @param {string} staff.id - The verified identity id.
     * @returns {Promise<IStaffContext>}
     */
    async staffContext(staff: { id: string; }): Promise<IStaffContext> {
        const here = findStaff(await this.rooms(), staff.id);

        if (!here) {
            return { where: 'nowhere' };
        }
        if (here.room.kind === 'lounge') {
            return { station: here.room.station, where: 'lounge' };
        }

        const encounter = this.describeEncounter(here.room.encounterId ?? '');

        if (!encounter) {
            return { where: 'nowhere' };
        }

        const open = this._state.encounters.find(e => e.id === encounter.id);

        return {
            chosenVideo: open?.videos?.[encounter.stage] ?? findPathway(this._opts.layout, encounter.pathway)?.stages
                .find(s => s.id === encounter.stage)?.defaultVideo,
            encounter: { id: encounter.id, stage: encounter.stage, stageName: encounter.stageName },
            videoPlaying: this._videos.has(encounter.id),
            videos: (this._opts.layout.videos ?? []).map(({ id, title }) => ({ id, title })),
            stages: (findPathway(this._opts.layout, encounter.pathway)?.stages ?? [])
                .filter(s => s.id !== DONE)
                .map(({ id, name }) => ({ id, name })),
            station: here.occupant.station,
            where: 'patients_room'
        };
    }

    /**
     * Puts an encounter in a stage on a staff member's request (ADR 0012): any stage of its pathway but `done`, and
     * only while the staff member is in that patient's own room. Afterwards the staff member is moved to the lounge of
     * their station. Every request is audited with the staff member's identity.
     *
     * @param {string} encounterId - The encounter.
     * @param {Stage} stage - The stage.
     * @param {Object} staff - The staff member, by verified identity.
     * @param {string} staff.id - The verified identity id.
     * @returns {Promise<IStaffStageResult>}
     */
    staffChangeStage(encounterId: string, stage: Stage, staff: { id: string; }): Promise<IStaffStageResult> {
        return this._serial(async () => {
            const at = new Date();
            const encounter = this._state.encounters.find(e => e.id === encounterId);
            const here = findStaff(await this.rooms(), staff.id);
            let refused: IStaffStageResult['refused'];

            if (!encounter) {
                refused = 'unknown_encounter';
            } else if (encounter.stage === DONE) {
                refused = 'encounter_closed';
            } else if (stage === DONE) {
                refused = 'done_is_not_for_staff';
            } else if (here?.room.kind !== 'patient' || here.room.encounterId !== encounter.id) {
                refused = 'not_in_patients_room';
            }

            const result = refused ? undefined : step(this._state, {
                at,
                encounterId,
                pathwayStages: (findPathway(this._opts.layout, encounter?.pathway ?? '')?.stages ?? []).map(s => s.id),
                stage,
                type: 'change_stage'
            });

            refused ??= result?.refused as IStaffStageResult['refused'];
            if (result) {
                this._commit(result.state);
            }
            this._audit(stageEntry({
                at,
                encounterId,
                from: encounter?.stage,
                issuer: staff.id,
                outcome: refused ? 'refused' : 'ok',
                reason: refused,
                to: stage
            }));
            if (refused || !here) {
                return { moved: false, refused };
            }

            // Free for the next patient at once: back to the lounge of their station.
            const lounge = stationsOf(this._opts.layout).find(s => s.id === here.occupant.station)?.lounge;

            if (!lounge) {
                return { encounter: result?.encounter, moved: false };
            }

            const move = await this._startMove({
                endpointId: here.occupant.endpointId, fromRoom: here.room.name, toRoom: lounge
            }, staff.id);

            return { encounter: result?.encounter, move, moved: move.state === 'counting_down' };
        });
    }

    /**
     * Starts a move. Call it inside the serial queue.
     *
     * @param {Object} request - Who to move, from which room to which.
     * @param {string} issuer - Who asked: `system`, or a verified identity id.
     * @returns {Promise<IMove>}
     */
    private async _startMove(request: { endpointId: string; fromRoom: string; toRoom: string; }, issuer: string): Promise<IMove> {
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
        clearInterval(this._videoWatch);
        this._videoWatch = undefined;
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
