/** Where a staff member is, as the coordinator service's `GET /staff/me` tells it. */
export interface IStaffContext {
    /** The video the encounter gets at its current stage: its own choice, else the stage's default. */
    chosenVideo?: string;
    encounter?: { id: string; stage: string; stageName: string; };

    /** The stages the staff member can pick: every stage of the encounter's pathway but done. */
    stages?: { id: string; name: string; }[];
    station?: string;

    /** Whether a waiting video plays in the patient's room now. */
    videoPlaying?: boolean;

    /** The waiting videos the staff member can choose from. */
    videos?: { id: string; title: string; }[];
    where: 'lounge' | 'nowhere' | 'patients_room';
}
