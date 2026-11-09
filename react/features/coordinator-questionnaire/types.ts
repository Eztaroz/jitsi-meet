/** A question, with exactly two answer choices. */
export interface IQuestion {
    choices: [string, string];
    text: string;
}

/** A health questionnaire the coordinator service sent to this patient, and that they have not answered yet. */
export interface IPendingQuestionnaire {
    id: string;
    questions: IQuestion[];
    title: string;
}
