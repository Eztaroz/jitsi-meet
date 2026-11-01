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
    displayName?: string;
    endpointId: string;
    identity?: { id?: string; name?: string; };
    role: Role;
}

export interface IRoom {

    /** The room name, which for a patient's room is the HN. */
    name: string;
    occupants: IOccupant[];
}

interface IRawIdentity {
    group?: string;
    user?: Record<string, string>;
}

interface IRawOccupant {
    displayName?: string;
    endpointId?: string;
    hidden?: boolean;
    identity?: IRawIdentity;
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
export function describeRooms(raw: unknown, markers: IRoleMarkers): IRoom[] {
    const rooms = (raw as { rooms?: unknown; } | undefined)?.rooms;

    if (!Array.isArray(rooms)) {
        return [];
    }

    return rooms.map((room: { name?: string; occupants?: unknown; }) => {
        const occupants = Array.isArray(room.occupants) ? room.occupants as IRawOccupant[] : [];

        return {
            name: decodeRoomName(room.name ?? ''),
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
                    displayName: o.displayName,
                    endpointId: o.endpointId ?? '',
                    identity: o.identity?.user
                        ? { id: o.identity.user.id, name: o.identity.user.name }
                        : undefined,
                    role
                };
            })
        };
    });
}
