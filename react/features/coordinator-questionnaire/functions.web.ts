import logger from './logger';
import { IPendingQuestionnaire } from './types';

/** The coordinator service's questionnaire route, behind the web server's proxy (`coordinator/deploy/nginx`). */
const QUESTIONNAIRE_PATH = '/coordinator/questionnaire';

/**
 * Parses what the coordinator service says is waiting for the patient.
 *
 * @param {unknown} json - The answer's body.
 * @returns {IPendingQuestionnaire|undefined} Undefined when nothing is waiting or the body is not a questionnaire.
 */
export function parsePending(json: unknown): IPendingQuestionnaire | undefined {
    const q = (json as { questionnaire?: Partial<IPendingQuestionnaire> | null; } | null)?.questionnaire;

    if (!q || typeof q.id !== 'string' || typeof q.title !== 'string' || !Array.isArray(q.questions)) {
        return undefined;
    }
    if (!q.questions.every(k => typeof k?.text === 'string' && Array.isArray(k.choices) && k.choices.length === 2)) {
        return undefined;
    }

    return q as IPendingQuestionnaire;
}

/**
 * Asks the coordinator service what is waiting for the patient, with the patient's own token.
 *
 * @param {string} jwt - The patient's token.
 * @returns {Promise<IPendingQuestionnaire|undefined|null>} Undefined when nothing is waiting, or the service cannot be
 * asked now; null when the token is not a patient's, or there is no such service, so that asking again is pointless.
 */
export async function fetchPending(jwt: string): Promise<IPendingQuestionnaire | undefined | null> {
    try {
        const response = await fetch(QUESTIONNAIRE_PATH, { headers: { authorization: `Bearer ${jwt}` } });

        if (response.status === 401 || response.status === 403 || response.status === 404) {
            return null;
        }

        return response.ok ? parsePending(await response.json()) : undefined;
    } catch (error) {
        logger.debug('Could not ask for a questionnaire', error);

        return undefined;
    }
}

/**
 * Sends the patient's answers.
 *
 * @param {string} jwt - The patient's token.
 * @param {string} id - The questionnaire's sending id.
 * @param {number[]} answers - For each question, the index of the chosen choice.
 * @returns {Promise<boolean>} Whether the service kept them.
 */
export async function sendAnswers(jwt: string, id: string, answers: number[]): Promise<boolean> {
    try {
        const response = await fetch(QUESTIONNAIRE_PATH, {
            body: JSON.stringify({ answers, id }),
            headers: { authorization: `Bearer ${jwt}`, 'content-type': 'application/json' },
            method: 'POST'
        });

        return response.ok;
    } catch (error) {
        logger.warn('Could not send the answers', error);

        return false;
    }
}
