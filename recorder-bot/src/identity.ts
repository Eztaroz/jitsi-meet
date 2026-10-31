/**
 * Participants' verified identities and roles.
 *
 * With JWT authentication and Prosody's `presence_identity` module, Prosody copies the token's `context.user` claims
 * and its `context.group` claim into every presence the participant sends, and drops any identity the client put
 * there itself. lib-jitsi-meet reads it back as `{ user: { id, name, ... }, group }`, every value as text.
 *
 * Whether a participant is staff or the patient comes from a role marker: one of those claims, and the value it must
 * have. The service trusts a presence identity only when a role marker is configured, because that is how an operator
 * says the deployment verifies identities: without `presence_identity`, the identity is whatever the client claims.
 */
import type { IIdentity, Role } from './consultationLifecycle.ts';

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

/** A participant as the service knows it. */
export interface IParticipantIdentity {
    identity?: IIdentity;
    role: Role;
}

/**
 * Parses a role marker, written `<claim>=<value>`: `group=<value>` or `user.<claim>=<value>`. The claim is in the
 * token's `context`.
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
 * Returns a value of an object.
 *
 * @param {unknown} object - The object, or anything else.
 * @param {string} key - The key.
 * @returns {unknown} Undefined when `object` is not an object.
 */
function field(object: unknown, key: string): unknown {
    return typeof object === 'object' && object !== null ? (object as Record<string, unknown>)[key] : undefined;
}

/**
 * Returns a value of an object, if it is a string.
 *
 * @param {unknown} object - The object, or anything else.
 * @param {string} key - The key.
 * @returns {string|undefined}
 */
function stringAt(object: unknown, key: string): string | undefined {
    const value = field(object, key);

    return typeof value === 'string' ? value : undefined;
}

/**
 * Whether a presence identity carries a role marker's claim with the marker's value.
 *
 * @param {unknown} raw - The presence identity.
 * @param {IRoleMarker|undefined} marker - The marker.
 * @returns {boolean}
 */
function hasMarker(raw: unknown, marker: IRoleMarker | undefined): boolean {
    if (!marker) {
        return false;
    }

    const [ first, claim ] = marker.path;
    const value = first === 'group' ? stringAt(raw, 'group') : stringAt(field(raw, 'user'), claim);

    return value === marker.value;
}

/**
 * Reads a participant's identity and role from the identity in its presence.
 *
 * @param {unknown} raw - The presence identity, as lib-jitsi-meet reports it; anything else when there is none.
 * @param {IRoleMarkers} markers - The role markers.
 * @returns {IParticipantIdentity} No identity and role `unknown` when no marker is configured or the presence has
 * no verified identity.
 */
export function participantIdentity(raw: unknown, markers: IRoleMarkers): IParticipantIdentity {
    const user = field(raw, 'user');
    const id = stringAt(user, 'id');

    if (!(markers.staff || markers.patient) || !id) {
        return { role: 'unknown' };
    }

    let role: Role = 'unknown';

    if (hasMarker(raw, markers.staff)) {
        role = 'staff';
    } else if (hasMarker(raw, markers.patient)) {
        role = 'patient';
    }

    return { identity: { id, name: stringAt(user, 'name') }, role };
}
