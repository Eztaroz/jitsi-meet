import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

import { Participant } from './Participant';
import { config } from './TestsConfig';
import { expectations } from './expectations';

/**
 * Helpers for the specs/recorderBot tests, which drive the recorder bot service (recorder-bot/) through its control
 * API and observe the conference from ordinary participants.
 */

/** A consultation as the control API reports it. */
export interface IConsultation {
    consultationId: string;
    error?: string;

    /** Where the evidence recording is, relative to the evidence storage root, once it is stored. */
    evidenceLocation?: string;
    startedAt: string;
    status: string;
    stopReason?: string;
    stoppedAt?: string;
}

/**
 * Returns why the recorder bot tests cannot run here, or undefined when they can.
 *
 * @returns {string|undefined}
 */
export function recorderBotUnavailableReason(): string | undefined {
    if (!expectations.recorderBot.available) {
        return 'the recorder bot is not expected to be available';
    }
    if (!config.recorderBot.apiUrl || !config.recorderBot.apiSecret) {
        return 'RECORDER_BOT_API_URL and RECORDER_BOT_API_SECRET are not set';
    }

    return undefined;
}

/**
 * Returns why the evidence tests cannot run here, or undefined when they can. They also need the evidence storage
 * root, where they read the stored evidence recordings.
 *
 * @returns {string|undefined}
 */
export function evidenceUnavailableReason(): string | undefined {
    return recorderBotUnavailableReason()
        ?? (config.recorderBot.storageRoot ? undefined : 'RECORDER_BOT_STORAGE_ROOT is not set');
}

/**
 * Calls the control API.
 *
 * @param {string} route - The path, starting with "/".
 * @param {RequestInit} init - Request options.
 * @param {string} apiUrl - Which instance of the service; the main one by default.
 * @returns {Promise<Response>}
 */
function callApi(route: string, init: RequestInit = {}, apiUrl = config.recorderBot.apiUrl): Promise<Response> {
    return fetch(`${apiUrl}${route}`, {
        ...init,
        headers: {
            'Authorization': `Bearer ${config.recorderBot.apiSecret}`,
            'Content-Type': 'application/json'
        }
    });
}

/**
 * Asks the service to record the consultation of a patient, and returns its answer whatever it is.
 *
 * @param {string} hn - The patient's HN.
 * @param {string} apiUrl - Which instance of the service; the main one by default.
 * @returns {Promise<Object>} The HTTP status and the body.
 */
export async function postConsultation(hn: string, apiUrl?: string): Promise<{ body: IConsultation; status: number; }> {
    const response = await callApi('/consultations', {
        body: JSON.stringify({ hn }),
        method: 'POST'
    }, apiUrl);

    return { body: await response.json() as IConsultation, status: response.status };
}

/**
 * Asks the service to record the consultation of a patient.
 *
 * @param {string} hn - The patient's HN.
 * @param {string} apiUrl - Which instance of the service; the main one by default.
 * @returns {Promise<IConsultation>}
 */
export async function startConsultation(hn: string, apiUrl?: string): Promise<IConsultation> {
    const { body, status } = await postConsultation(hn, apiUrl);

    if (status !== 200 && status !== 201) {
        throw new Error(`POST /consultations failed with ${status}`);
    }

    return body;
}

/**
 * Reads the service's health.
 *
 * @param {string} apiUrl - Which instance of the service; the main one by default.
 * @returns {Promise<Object>}
 */
export async function getHealth(apiUrl?: string): Promise<{ activeConsultations: number; maxConsultations: number; }> {
    const response = await callApi('/health', {}, apiUrl);

    if (!response.ok) {
        throw new Error(`GET /health failed with ${response.status}`);
    }

    return await response.json() as { activeConsultations: number; maxConsultations: number; };
}

/**
 * Reads a consultation.
 *
 * @param {string} consultationId - The consultation.
 * @param {string} apiUrl - Which instance of the service; the main one by default.
 * @returns {Promise<IConsultation>}
 */
export async function getConsultation(consultationId: string, apiUrl?: string): Promise<IConsultation> {
    const response = await callApi(`/consultations/${consultationId}`, {}, apiUrl);

    if (!response.ok) {
        throw new Error(`GET /consultations/${consultationId} failed with ${response.status}`);
    }

    return await response.json() as IConsultation;
}

/**
 * Polls a consultation until it matches.
 *
 * @param {string} consultationId - The consultation.
 * @param {Function} predicate - What to wait for.
 * @param {Object} options - Options.
 * @param {string} options.description - What is awaited, for the failure message.
 * @param {number} options.timeout - How long to wait, in milliseconds.
 * @returns {Promise<IConsultation>} The matching consultation.
 */
export async function waitForConsultation(
        consultationId: string,
        predicate: (consultation: IConsultation) => boolean,
        { description, timeout = 30_000 }: { description: string; timeout?: number; }): Promise<IConsultation> {
    const deadline = Date.now() + timeout;
    let consultation = await getConsultation(consultationId);

    while (!predicate(consultation)) {
        if (Date.now() > deadline) {
            throw new Error(`Timed out waiting for ${description}; last status ${JSON.stringify(consultation)}`);
        }
        await new Promise(resolve => setTimeout(resolve, 500));
        consultation = await getConsultation(consultationId);
    }

    return consultation;
}

/**
 * Waits until the bot records the consultation, that is once it is in the conference.
 *
 * @param {string} consultationId - The consultation.
 * @returns {Promise<IConsultation>}
 */
export function waitForRecording(consultationId: string): Promise<IConsultation> {
    return waitForConsultation(consultationId, c => c.status === 'recording', {
        description: 'the bot to join'
    });
}

/**
 * Waits until the consultation has stopped.
 *
 * @param {string} consultationId - The consultation.
 * @param {number} timeout - How long to wait, in milliseconds.
 * @returns {Promise<IConsultation>}
 */
export function waitForStop(consultationId: string, timeout = 30_000): Promise<IConsultation> {
    return waitForConsultation(consultationId, c => Boolean(c.stopReason), {
        description: 'the consultation to stop',
        timeout
    });
}

/**
 * Returns an HN unique to this test run. It has upper-case letters and a "/", which the room name has to encode.
 *
 * @param {string} label - Distinguishes the HNs of one test file.
 * @returns {string}
 */
export function uniqueHn(label = ''): string {
    return `HN/${label}${ctx.roomName}`.toUpperCase();
}

/**
 * Returns the room part of a patient's link: the HN, URL-encoded.
 *
 * @param {string} hn - The patient's HN.
 * @returns {string}
 */
export function patientLinkRoom(hn: string): string {
    return encodeURIComponent(hn);
}

/** What a participant sees of the hidden participants in the conference. */
export interface IHiddenView {

    /** Hidden participants in the conference, as lib-jitsi-meet sees them. */
    hidden: Array<{ role: string; }>;

    /** Remote participants the UI knows about. */
    remote: number;
}

/**
 * Reports what a participant sees of the conference's participants.
 *
 * @param {Participant} participant - The participant.
 * @returns {Promise<IHiddenView>}
 */
export function getHiddenView(participant: Participant): Promise<IHiddenView> {
    return participant.execute(() => {
        const conference = APP.conference._room;

        return {
            hidden: conference.getParticipants()
                .filter((p: any) => p.isHidden())
                .map((p: any) => {
                    return { role: p.getRole() };
                }),
            remote: APP.store.getState()['features/base/participants'].remote.size
        };
    });
}

/**
 * Waits until a participant sees the bot in the conference.
 *
 * @param {Participant} participant - The participant.
 * @returns {Promise<void>}
 */
export async function waitForHiddenParticipant(participant: Participant): Promise<void> {
    await participant.driver.waitUntil(
        async () => (await getHiddenView(participant)).hidden.length > 0,
        {
            timeout: 10_000,
            timeoutMsg: `${participant.name} does not see the bot in the conference`
        });
}

/**
 * Starts noting the participant-joined notifications a participant is shown.
 *
 * @param {Participant} participant - The participant.
 * @returns {Promise<void>}
 */
export async function watchJoinNotifications(participant: Participant): Promise<void> {
    await participant.execute(() => {
        const seen = new Set();
        const titles: string[] = [];

        // @ts-ignore
        window.recorderBotTestJoinNotifications = titles;
        // @ts-ignore The app's store is a full redux store.
        APP.store.subscribe(() => {
            for (const notification of APP.store.getState()['features/notifications'].notifications) {
                const props: { titleArguments?: object; titleKey?: string; } = notification.props ?? {};

                if (!seen.has(notification.uid) && props.titleKey?.startsWith('notify.connected')) {
                    seen.add(notification.uid);
                    titles.push(JSON.stringify(props.titleArguments ?? {}));
                }
            }
        });
    });
}

/**
 * Returns the participant-joined notifications noted since {@link watchJoinNotifications}.
 *
 * @param {Participant} participant - The participant.
 * @returns {Promise<string[]>} Each notification's title arguments, which name who joined.
 */
export function getJoinNotifications(participant: Participant): Promise<string[]> {
    // @ts-ignore
    return participant.execute(() => [ ...window.recorderBotTestJoinNotifications ]);
}

/**
 * Waits until a participant shows the recording label for a consultation: jitsi-meet holds a file recording session
 * with the consultation's id that is on, which is what the in-call label shows, and the label is on screen.
 *
 * @param {Participant} participant - The participant.
 * @param {string} consultationId - The consultation.
 * @returns {Promise<void>}
 */
export async function waitForRecordingLabel(participant: Participant, consultationId: string): Promise<void> {
    await participant.driver.waitUntil(
        () => participant.execute(id => APP.store.getState()['features/recording'].sessionDatas.some(
            session => session.id === id && session.mode === 'file' && session.status === 'on'), consultationId),
        {
            timeout: 10_000,
            timeoutMsg: `${participant.name} has no recording session for the consultation`
        });

    // The always-visible part of the conference info holds the label, and nothing else in these tests.
    await participant.driver.$('#alwaysVisible svg').waitForDisplayed({
        timeout: 5_000,
        timeoutMsg: `${participant.name} does not show the recording label`
    });
}

/**
 * Waits until the consultation's evidence recording is in the evidence storage root.
 *
 * @param {string} consultationId - The consultation.
 * @param {number} timeout - How long to wait, in milliseconds.
 * @returns {Promise<IConsultation>}
 */
export function waitForEvidence(consultationId: string, timeout = 30_000): Promise<IConsultation> {
    return waitForConsultation(consultationId, c => [ 'stored', 'spooled', 'failed' ].includes(c.status), {
        description: 'the evidence recording to be stored',
        timeout
    }).then(consultation => {
        if (consultation.status !== 'stored' || !consultation.evidenceLocation) {
            throw new Error(`The evidence recording was not stored: ${JSON.stringify(consultation)}`);
        }

        return consultation;
    });
}

/** One media file of an evidence recording, as its manifest lists it. */
export interface IEvidenceFile {
    bytes: number;
    duration: number | null;
    endpointId: string;
    kind: 'audio' | 'video';
    name: string;
    start: string;
    stop: string;
}

/** An evidence recording's manifest.json. */
export interface IManifest {
    consultationId: string;
    end: string;
    files: IEvidenceFile[];
    gaps: Array<{ end: string; start: string; }>;
    hn: string;
    meetingId?: string;
    participants: Array<{ displayName?: string; endpointId: string; joins: string[]; leaves: string[]; }>;
    room: string;
    staffVisits: unknown[];
    start: string;
    stopReason: string;
}

/** One entry of an evidence recording's timeline.json. */
export interface ITimelineEntry {
    [key: string]: unknown;
    at: string;
    type: string;
}

/**
 * Returns the path of a file in a stored evidence recording.
 *
 * @param {string} location - The evidence location the control API reported.
 * @param {string} name - The file's name.
 * @returns {string}
 */
export function evidencePath(location: string, name = ''): string {
    return path.resolve(config.recorderBot.storageRoot ?? '', location, name);
}

/**
 * Reads a JSON file of a stored evidence recording.
 *
 * @param {string} location - The evidence location the control API reported.
 * @param {string} name - The file's name.
 * @returns {T}
 */
export function readEvidenceJson<T>(location: string, name: 'manifest.json' | 'timeline.json'): T {
    return JSON.parse(fs.readFileSync(evidencePath(location, name), 'utf8')) as T;
}

/** What playing a media file all the way through shows. */
export interface IPlayback {

    /** The container's duration, in seconds. */
    duration: number;

    /** The heights of the decoded video frames, in order, without repeats. Empty for audio. */
    heights: number[];
}

/**
 * Plays a media file through with ffmpeg and ffprobe: decodes every frame, failing on any decoding error, and reads
 * its duration and frame sizes.
 *
 * @param {string} file - The file.
 * @returns {IPlayback}
 */
export function playMedia(file: string): IPlayback {
    // -xerror: stop with a failure at the first decoding error.
    execFileSync('ffmpeg', [ '-v', 'error', '-xerror', '-i', file, '-f', 'null', '-' ], { stdio: 'pipe' });

    const probe = (args: string[]) =>
        execFileSync('ffprobe', [ '-v', 'error', ...args, '-of', 'csv=p=0', file ], { encoding: 'utf8' }).trim();
    const heights: number[] = [];

    for (const line of probe([ '-select_streams', 'v:0', '-show_entries', 'frame=height' ]).split('\n')) {
        const height = Number(line);

        if (line && height !== heights[heights.length - 1]) {
            heights.push(height);
        }
    }

    return {
        duration: Number(probe([ '-show_entries', 'format=duration' ])),
        heights
    };
}

/**
 * Changes the resolution a participant's camera captures at, which changes the resolution the bot receives.
 *
 * @param {Participant} participant - The participant.
 * @param {number} height - The new height; the width follows at 16:9.
 * @returns {Promise<void>}
 */
export async function setCameraHeight(participant: Participant, height: number): Promise<void> {
    await participant.execute(async h => {
        const track = APP.store.getState()['features/base/tracks']
            .find(t => t.local && t.mediaType === 'video')?.jitsiTrack.getTrack();

        await track?.applyConstraints({ height: h, width: Math.round(h * 16 / 9) });
    }, height);
}
