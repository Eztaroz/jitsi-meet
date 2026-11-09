import { backendSafeRoomName } from './roomName.ts';

/**
 * Turns what Prosody reports about the open rooms into the coordinator's view: who is in each room, and whether each
 * occupant is a patient or staff, by the deployment's role markers.
 */

export type Role = 'hidden' | 'patient' | 'staff' | 'unknown' | 'video_player';

/** One claim of the presence identity, and the value that marks a role. */
export interface IRoleMarker {

    /** `group`, or `user.<claim>`. */
    path: [ 'group' ] | [ 'user', string ];
    value: string;
}

export interface IRoleMarkers {
    patient?: IRoleMarker;
    staff?: IRoleMarker;

    /** The video player: a visible, non-human participant that plays a waiting video. */
    videoPlayer?: IRoleMarker;
}

export interface IOccupant {

    /** The id of the move this occupant said they cancel. */
    cancelledMove?: string;
    displayName?: string;
    endpointId: string;
    identity?: { id?: string; name?: string; };
    role: Role;

    /**
     * For staff, the station they are with: the one whose lounge they are in, or, in a patient's own room, the one
     * whose lounge they were last seen in (ADR 0011).
     */
    station?: string;

    /** Whether the occupant's client says it obeys move commands. */
    supportsMove: boolean;
}

/** The stage a station serves: the id of a stage of the pathways, other than waiting and done. */
export type StationStage = string;

/** A center's team of staff for one stage, and the lounge where its free staff wait (ADR 0011). */
export interface IStation {
    id: string;

    /** The room name of the station's lounge. */
    lounge: string;
    stage: StationStage;
}

/** One step of a pathway: its id, its Thai name and the waiting video played by default while a patient waits in it. */
export interface IStage {
    defaultVideo?: string;
    id: string;
    name: string;
}

/** The stages an encounter goes through, in order, from `waiting` to `done` (ADR 0013). */
export interface IPathway {
    id: string;
    stages: IStage[];
}

/** A specialty service of a center; it may have a pathway of its own. */
export interface IClinic {
    id: string;
    pathway?: string;
}

/** A part of the hospital with its stations, clinics and the pathways its encounters can follow. */
export interface ICenter {
    clinics?: IClinic[];
    id: string;

    /** The id of the center's own pathway, one of `pathways`; unset, the default one. */
    pathway?: string;

    /** The pathways the center offers. One with the id `default` replaces the built-in default pathway. */
    pathways?: IPathway[];
    stations: IStation[];
}

/** A waiting video the deployment hosts: `file` is a path under the web server's base URL for videos. */
export interface IVideo {
    file: string;
    id: string;
    title: string;
}

/** The parts of the hospital the deployment serves, each with its stations (`GLOSSARY.md`). */
export interface ILayout {
    centers: ICenter[];

    /** The deployment's waiting videos. */
    videos?: IVideo[];
}

export interface IRoom {

    /** For a patient's room, the open encounter of that HN, if there is one. */
    encounterId?: string;
    kind: 'lounge' | 'patient';

    /** The room name, which for a patient's room is the HN. */
    name: string;
    occupants: IOccupant[];

    /** False for a lounge that nobody is in. */
    open: boolean;

    /** For a lounge, its station. */
    stage?: StationStage;
    station?: string;
}

/**
 * Lists every station of every center.
 *
 * @param {ILayout} layout - The layout.
 * @returns {IStation[]}
 */
export function stationsOf(layout: ILayout): IStation[] {
    return layout.centers.flatMap(c => c.stations);
}

/**
 * Finds the station whose lounge a room is.
 *
 * @param {ILayout} layout - The layout.
 * @param {string} room - A room name, as Prosody or a person writes it.
 * @returns {IStation|undefined}
 */
export function stationOfLounge(layout: ILayout, room: string): IStation | undefined {
    return stationsOf(layout).find(s => sameRoom(s.lounge, room));
}

interface IRawIdentity {
    group?: string;
    user?: Record<string, string>;
}

interface IRawOccupant {
    cancelledMove?: string;
    displayName?: string;
    endpointId?: string;
    hidden?: boolean;
    identity?: IRawIdentity;
    supportsMove?: boolean;
}

/**
 * Parses a role marker, written `<claim>=<value>`: `group=<value>` or `user.<claim>=<value>`.
 *
 * @param {string|undefined} raw - The marker.
 * @param {string} name - The variable it came from, for the error.
 * @returns {IRoleMarker|undefined} Undefined when unset.
 * @throws {Error} When it is malformed.
 */
export function parseRoleMarker(raw: string | undefined, name: string): IRoleMarker | undefined {
    const marker = raw?.trim();

    if (!marker) {
        return undefined;
    }

    const separator = marker.indexOf('=');
    const claim = marker.slice(0, separator).trim();
    const value = marker.slice(separator + 1).trim();
    const user = /^user\.(.+)$/.exec(claim);

    if (separator < 0 || !value || !(claim === 'group' || user)) {
        throw new Error(`${name} must be "group=<value>" or "user.<claim>=<value>", got "${marker}"`);
    }

    return { path: user ? [ 'user', user[1] ] : [ 'group' ], value };
}

/**
 * Tells whether an identity carries a role marker.
 *
 * @param {IRawIdentity|undefined} identity - The occupant's verified identity.
 * @param {IRoleMarker|undefined} marker - The marker.
 * @returns {boolean}
 */
function matches(identity: IRawIdentity | undefined, marker: IRoleMarker | undefined): boolean {
    if (!identity || !marker) {
        return false;
    }

    return (marker.path[0] === 'group' ? identity.group : identity.user?.[marker.path[1]]) === marker.value;
}

/**
 * Decodes a room name from the room's address, where Jitsi percent-encodes characters such as "/".
 *
 * @param {string} name - The name in the address.
 * @returns {string} The name as people know it; the input when it is not valid percent-encoding.
 */
function decodeRoomName(name: string): string {
    try {
        return decodeURIComponent(name);
    } catch {
        return name;
    }
}

/**
 * Describes the rooms Prosody reported.
 *
 * @param {unknown} raw - Prosody's answer.
 * @param {IRoleMarkers} markers - Which identities are patients and which staff.
 * @returns {IRoom[]}
 */
export function describeRooms(raw: unknown, markers: IRoleMarkers, layout: ILayout = { centers: [] }): IRoom[] {
    const rooms = (raw as { rooms?: unknown; } | undefined)?.rooms;
    const open = describeOpenRooms(Array.isArray(rooms) ? rooms : [], markers, layout);
    const isOpen = (configured: string) => open.some(r => sameRoom(r.name, configured));

    // The lounges nobody is in are listed too, closed, so that staff can be moved into them.
    return [
        ...open,
        ...stationsOf(layout).filter(s => !isOpen(s.lounge)).map(s => {
            return { kind: 'lounge' as const, name: s.lounge, occupants: [], open: false, stage: s.stage, station: s.id };
        })
    ];
}

/**
 * Tells whether two names are of the same room: Prosody names a room by the lower-case URL-encoded name.
 *
 * @param {string} a - One name.
 * @param {string} b - The other.
 * @returns {boolean}
 */
export function sameRoom(a: string, b: string): boolean {
    return backendSafeRoomName(a) === backendSafeRoomName(b);
}

/**
 * Describes the rooms Prosody reported as open.
 *
 * @param {Object[]} rooms - Prosody's rooms.
 * @param {IRoleMarkers} markers - Which identities are patients and which staff.
 * @param {ILayout} layout - The configured rooms.
 * @returns {IRoom[]}
 */
function describeOpenRooms(rooms: { name?: string; occupants?: unknown; }[], markers: IRoleMarkers, layout: ILayout): IRoom[] {
    return rooms.map((room: { name?: string; occupants?: unknown; }) => {
        const occupants = Array.isArray(room.occupants) ? room.occupants as IRawOccupant[] : [];

        const name = decodeRoomName(room.name ?? '');
        const station = stationOfLounge(layout, name);

        return {
            kind: station ? 'lounge' : 'patient',
            name,
            open: true,
            ...station ? { stage: station.stage, station: station.id } : {},
            occupants: occupants.map(o => {
                let role: Role = 'unknown';

                if (o.hidden) {
                    role = 'hidden';
                } else if (matches(o.identity, markers.patient)) {
                    role = 'patient';
                } else if (matches(o.identity, markers.staff)) {
                    role = 'staff';
                } else if (matches(o.identity, markers.videoPlayer)) {
                    role = 'video_player';
                }

                return {
                    cancelledMove: o.cancelledMove,
                    displayName: o.displayName,
                    endpointId: o.endpointId ?? '',
                    identity: o.identity?.user
                        ? { id: o.identity.user.id, name: o.identity.user.name }
                        : undefined,
                    role,
                    ...station && role === 'staff' ? { station: station.id } : {},
                    supportsMove: Boolean(o.supportsMove)
                };
            })
        };
    });
}
