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
