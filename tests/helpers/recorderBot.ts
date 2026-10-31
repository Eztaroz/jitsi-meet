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
 * Calls the control API.
 *
 * @param {string} path - The path, starting with "/".
 * @param {RequestInit} init - Request options.
 * @returns {Promise<Response>}
 */
function callApi(path: string, init: RequestInit = {}): Promise<Response> {
    return fetch(`${config.recorderBot.apiUrl}${path}`, {
        ...init,
        headers: {
            'Authorization': `Bearer ${config.recorderBot.apiSecret}`,
            'Content-Type': 'application/json'
        }
    });
}

/**
 * Asks the service to record the consultation of a patient.
 *
 * @param {string} hn - The patient's HN.
 * @returns {Promise<IConsultation>}
 */
export async function startConsultation(hn: string): Promise<IConsultation> {
    const response = await callApi('/consultations', {
        body: JSON.stringify({ hn }),
        method: 'POST'
    });

    if (!response.ok) {
        throw new Error(`POST /consultations failed with ${response.status}`);
    }

    return await response.json() as IConsultation;
}

/**
 * Reads a consultation.
 *
 * @param {string} consultationId - The consultation.
 * @returns {Promise<IConsultation>}
 */
export async function getConsultation(consultationId: string): Promise<IConsultation> {
    const response = await callApi(`/consultations/${consultationId}`);

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
