/** Where a staff member is, as the coordinator service's `GET /staff/me` tells it. */
export interface IStaffContext {
    /** The video the encounter gets at its current stage: its own choice, else the stage's default. */
    chosenVideo?: string;
    encounter?: { id: string; stage: string; stageName: string; };

    /** In a patient's room: the questionnaires the staff member can send. */
    questionnaires?: { id: string; title: string; }[];

    /** The stages the staff member can pick: every stage of the encounter's pathway but done. */
    stages?: { id: string; name: string; }[];
    station?: string;

    /** Whether a waiting video plays in the patient's room now. */
    videoPlaying?: boolean;

    /** The waiting videos the staff member can choose from. */
    videos?: { id: string; title: string; }[];
    where: 'lounge' | 'nowhere' | 'patients_room';
}

/** A questionnaire sent in this encounter, as `GET /staff/encounters/<id>/questionnaires` tells it. */
export interface IStaffQuestionnaire {

    answeredAt?: string;
    /** The index (0 or 1) of the chosen choice for each question; none until the patient answered. */
    answers?: number[];
    id: string;
    questions: { choices: string[]; text: string; }[];
    title: string;
}
