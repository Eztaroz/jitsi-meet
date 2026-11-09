import { type ILayout, type IRoom, stationsOf } from './rooms.ts';

/** A staff member of a station, as the coordinator's screen shows them. */
export interface ITeamMember {
    endpointId: string;

    /** The verified identity id. */
    id?: string;
    name: string;
}

/** A staff member who is in a patient's room, and the patient they are with. */
export interface IBusyMember extends ITeamMember {

    /** The open encounter of the patient's room, if there is one. */
    encounterId?: string;

    /** The patient's HN, which names the room. */
    hn: string;
}

/** A station as a team: its free staff, in its lounge, and its busy staff, in patients' rooms (ADR 0011). */
export interface ITeam {
    busy: IBusyMember[];
    free: ITeamMember[];
    id: string;
    lounge: string;
    stage: string;
}

/**
 * Describes each station as a team. Membership is derived from where staff are: a staff member in a station's lounge is
 * free; one in a patient's room, who was last seen in a station's lounge, is busy with that patient. Staff whose
 * station is not known are in no team.
 *
 * @param {ILayout} layout - The layout.
 * @param {IRoom[]} rooms - The rooms, as the service describes them: staff in a patient's room carry their station.
 * @returns {ITeam[]}
 */
export function describeTeams(layout: ILayout, rooms: IRoom[]): ITeam[] {
    const staffOf = (room: IRoom) => room.occupants.filter(o => o.role === 'staff');
    const member = (o: IRoom['occupants'][number]): ITeamMember => ({
        endpointId: o.endpointId,
        id: o.identity?.id,
        name: o.identity?.name || o.displayName || ''
    });

    return stationsOf(layout).map(station => ({
        busy: rooms.filter(r => r.kind === 'patient').flatMap(room => staffOf(room)
            .filter(o => o.station === station.id)
            .map(o => ({ ...member(o), encounterId: room.encounterId, hn: room.name }))),
        free: rooms.filter(r => r.kind === 'lounge' && r.station === station.id)
            .flatMap(room => staffOf(room).map(member)),
        id: station.id,
        lounge: station.lounge,
        stage: station.stage
    }));
}

/**
 * Finds, for each encounter, the stations whose staff are in the patient's room now.
 *
 * @param {ITeam[]} teams - The teams.
 * @returns {Record<string, string[]>} The station ids by encounter id; encounters with no staff are left out.
 */
export function stationsAt(teams: ITeam[]): Record<string, string[]> {
    const at: Record<string, string[]> = {};

    for (const team of teams) {
        for (const { encounterId } of team.busy) {
            if (encounterId && !at[encounterId]?.includes(team.id)) {
                (at[encounterId] ??= []).push(team.id);
            }
        }
    }

    return at;
}
