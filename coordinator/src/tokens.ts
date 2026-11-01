/**
 * The token a moved participant joins the destination with (ADR 0009): it names the destination room only, carries
 * the participant's own verified identity and the claim that marks their role, and expires after a few minutes.
 */
import type { IRoleMarkers, Role } from './rooms.ts';

/**
 * Names a room as Prosody and jitsi-meet do (`getBackendSafeRoomName`): NFKC, lower case, URL-encoded, lower case
 * again. A token's room claim and the room's address both use it.
 *
 * @param {string} name - The room name as people know it, such as an HN.
 * @returns {string}
 */
export function backendSafeRoomName(name: string): string {
    // encodeURIComponent leaves "*" alone, and a token whose room is "*" is let into any room.
    return encodeURIComponent(name.normalize('NFKC').toLowerCase()).replace(/\*/gu, '%2a').toLowerCase();
}

/**
 * Builds the claims of a destination token.
 *
 * @param {Object} options - Options.
 * @param {string} options.audience - The token audience Prosody accepts.
 * @param {{ id?: string; name?: string; }} options.identity - The participant's verified identity.
 * @param {string} options.issuer - The issuer Prosody accepts for the coordinator service's key.
 * @param {number} options.lifetimeMs - How long the token lasts.
 * @param {IRoleMarkers} options.markers - The deployment's role markers.
 * @param {Date} options.now - When it is issued.
 * @param {Role} options.role - The participant's role.
 * @param {string} options.room - The destination room.
 * @param {string} options.subject - The token subject, as the deployment's tokens have.
 * @returns {Record<string, unknown>}
 */
export function destinationClaims({ audience, identity, issuer, lifetimeMs, markers, now, role, room, subject }: {
    audience: string;
    identity: { id?: string; name?: string; };
    issuer: string;
    lifetimeMs: number;
    markers: IRoleMarkers;
    now: Date;
    role: Role;
    room: string;
    subject: string;
}): Record<string, unknown> {
    const user: Record<string, string> = {};
    const context: { group?: string; user: Record<string, string>; } = { user };
    const marker = role === 'patient' ? markers.patient : role === 'staff' ? markers.staff : undefined;

    if (identity.id) {
        user.id = identity.id;
    }
    if (identity.name) {
        user.name = identity.name;
    }
    if (marker?.path[0] === 'user') {
        user[marker.path[1]] = marker.value;
    } else if (marker) {
        context.group = marker.value;
    }

    const seconds = Math.floor(now.getTime() / 1000);

    return {
        aud: audience,
        context,
        exp: seconds + Math.floor(lifetimeMs / 1000),
        iss: issuer,
        nbf: seconds - 10,
        room: backendSafeRoomName(room),
        sub: subject
    };
}
