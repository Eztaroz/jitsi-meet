/**
 * Health questionnaires: short questions, two answer choices each, that staff or a coordinator send to a patient and the
 * patient answers alone in their own room (`GLOSSARY.md`). The answers belong to the encounter.
 */

/** A question, with exactly two answer choices. */
export interface IQuestion {
    choices: [string, string];
    text: string;
}

/** A questionnaire the deployment offers. */
export interface IQuestionnaire {
    id: string;
    questions: IQuestion[];
    title: string;
}

/** One questionnaire sent to a patient during an encounter, and what came of it. */
export interface ISentQuestionnaire {
    answeredAt?: Date;

    /** The patient's answer to each question, as the index (0 or 1) of the choice. Unset until they answer. */
    answers?: (0 | 1)[];

    /** Set when the questionnaire stopped being shown without an answer: staff joined the room after it was sent. */
    closedAt?: Date;

    /** Opaque; tells this sending apart from the others of the encounter, and from other encounters'. */
    id: string;

    /** The questionnaire's id in the catalogue at the time. */
    questionnaire: string;

    /** The questions as they were sent, so that the answers stay readable if the configuration changes. */
    questions: IQuestion[];

    sentAt: Date;

    /** Who sent it: `system`, or a coordinator's or staff member's verified identity id. */
    sentBy: string;

    /**
     * The endpoint ids of the staff who were in the patient's room when it was sent. A staff member who joins with
     * another endpoint after that closes the questionnaire.
     */
    staffAtSend: string[];
    title: string;
}

/** What the patient's client shows. */
export interface IPatientQuestionnaire {
    id: string;
    questions: IQuestion[];
    title: string;
}

const MAX_TEXT = 500;

/**
 * Describes a questionnaire that was sent for a reader of the encounter: staff and coordinators. Which endpoints were
 * in the room when it was sent is kept private.
 *
 * @param {ISentQuestionnaire} sent - The sending.
 * @returns {Object}
 */
export function describeSent(sent: ISentQuestionnaire) {
    const { staffAtSend: _staffAtSend, ...rest } = sent;

    return rest;
}

/**
 * Checks and reads the catalogue of questionnaires of the configuration.
 *
 * @param {unknown} raw - The "questionnaires" of the rooms file; unset for none.
 * @param {Function} fail - Makes the error to throw.
 * @returns {IQuestionnaire[]|undefined} Undefined when unset.
 */
export function loadQuestionnaires(raw: unknown, fail: (why: string) => Error): IQuestionnaire[] | undefined {
    if (raw === undefined) {
        return undefined;
    }
    if (!Array.isArray(raw)) {
        throw fail('"questionnaires" must be a list');
    }

    const text = (value: unknown): value is string => typeof value === 'string' && value.trim() !== '' && value.length <= MAX_TEXT;
    const ids = new Set<string>();

    return (raw as { id?: unknown; questions?: unknown; title?: unknown; }[]).map(q => {
        if (!text(q?.id)) {
            throw fail('every questionnaire needs an "id"');
        }
        if (ids.has(q.id)) {
            throw fail(`two questionnaires are "${q.id}"`);
        }
        ids.add(q.id);
        if (!text(q.title)) {
            throw fail(`questionnaire "${q.id}" needs a "title"`);
        }
        if (!Array.isArray(q.questions) || q.questions.length === 0) {
            throw fail(`questionnaire "${q.id}" needs a list of questions`);
        }

        const questions = (q.questions as { choices?: unknown; text?: unknown; }[]).map((question, i) => {
            if (!text(question?.text)) {
                throw fail(`question ${i + 1} of questionnaire "${q.id}" needs a "text"`);
            }

            const choices = question.choices;

            if (!Array.isArray(choices) || choices.length !== 2 || !choices.every(text)) {
                throw fail(`question ${i + 1} of questionnaire "${q.id}" must have exactly two choices, each a `
                    + 'non-empty text');
            }

            return { choices: [ choices[0], choices[1] ] as [string, string], text: question.text };
        });

        return { id: q.id, questions, title: q.title };
    });
}

/**
 * Checks a patient's answers against the questions they were asked.
 *
 * @param {unknown} raw - What the patient's client sent: the index of the chosen choice for each question.
 * @param {IQuestion[]} questions - The questions.
 * @returns {(0|1)[]|undefined} The answers; undefined when they do not fit the questions.
 */
export function parseAnswers(raw: unknown, questions: IQuestion[]): (0 | 1)[] | undefined {
    if (!Array.isArray(raw) || raw.length !== questions.length || !raw.every(a => a === 0 || a === 1)) {
        return undefined;
    }

    return raw as (0 | 1)[];
}
