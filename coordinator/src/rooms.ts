import { backendSafeRoomName } from './roomName.ts';

/**
 * Turns what Prosody reports about the open rooms into the coordinator's view: who is in each room, and whether each
 * occupant is a patient or staff, by the deployment's role markers.
 */

export type Role = 'hidden' | 'patient' | 'staff' | 'unknown';

/** One claim of the presence identity, and the value that marks a role. */
export interface IRoleMarker {

    /** `group`, or `user.<claim>`. */
    path: [ 'group' ] | [ 'user', string ];
    value: string;
}

export interface IRoleMarkers {
    patient?: IRoleMarker;
    staff?: IRoleMarker;
}

export interface IOccupant {

    /** The id of the move this occupant said they cancel. */
    cancelledMove?: string;
    displayName?: string;
    endpointId: string;
    identity?: { id?: string; name?: string; };

    /** For a patient whose own room the service has learned, that room, wherever the patient is now. */
    ownRoom?: string;
    role: Role;

    /** Whether the occupant's client says it obeys move commands. */
    supportsMove: boolean;
}

/** The stages a station can belong to. */
export type StationStage = 'aftercare' | 'intake';

/** The rooms the deployment fixes: stations, each for a stage, and lounges (`GLOSSARY.md`). */
export interface ILayout {
    lounges: { room: string; }[];
    stations: { room: string; stage: StationStage; }[];
}

export interface IRoom {

    /** For a patient's room, the open encounter of that HN, if there is one. */
    encounterId?: string;
    kind: 'lounge' | 'patient' | 'station';

    /** The room name, which for a patient's room is the HN. */
    name: string;
    occupants: IOccupant[];

    /** False for a configured room that nobody is in. */
    open: boolean;

    /** The stage of a station. */
    stage?: StationStage;
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
export function describeRooms(raw: unknown, markers: IRoleMarkers, layout: ILayout = { lounges: [], stations: [] }): IRoom[] {
    const rooms = (raw as { rooms?: unknown; } | undefined)?.rooms;
    const open = describeOpenRooms(Array.isArray(rooms) ? rooms : [], markers, layout);
    const isOpen = (configured: string) => open.some(r => sameRoom(r.name, configured));

    // The configured rooms nobody is in are listed too, closed, so that they can be moved into.
    return [
        ...open,
        ...layout.stations.filter(s => !isOpen(s.room)).map(s => {
            return { kind: 'station' as const, name: s.room, occupants: [], open: false, stage: s.stage };
        }),
        ...layout.lounges.filter(l => !isOpen(l.room)).map(l => {
            return { kind: 'lounge' as const, name: l.room, occupants: [], open: false };
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
function sameRoom(a: string, b: string): boolean {
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
        const station = layout.stations.find(st => sameRoom(st.room, name));
        const lounge = layout.lounges.some(l => sameRoom(l.room, name));

        return {
            kind: station ? 'station' : lounge ? 'lounge' : 'patient',
            name,
            open: true,
            stage: station?.stage,
            occupants: occupants.map(o => {
                let role: Role = 'unknown';

                if (o.hidden) {
                    role = 'hidden';
                } else if (matches(o.identity, markers.patient)) {
                    role = 'patient';
                } else if (matches(o.identity, markers.staff)) {
                    role = 'staff';
                }

                return {
                    cancelledMove: o.cancelledMove,
                    displayName: o.displayName,
                    endpointId: o.endpointId ?? '',
                    identity: o.identity?.user
                        ? { id: o.identity.user.id, name: o.identity.user.name }
                        : undefined,
                    role,
                    supportsMove: Boolean(o.supportsMove)
                };
            })
        };
    });
}
