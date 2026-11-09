/** Where a staff member is, as the coordinator service's `GET /staff/me` tells it. */
export interface IStaffContext {
    encounter?: { id: string; stage: string; stageName: string; };

    /** The stages the staff member can pick: every stage of the encounter's pathway but done. */
    stages?: { id: string; name: string; }[];
    station?: string;
    where: 'lounge' | 'nowhere' | 'patients_room';
}
