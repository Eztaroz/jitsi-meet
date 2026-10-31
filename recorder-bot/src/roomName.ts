/**
 * Derives the conference room from a patient's HN with exactly the normalisation jitsi-meet applies to the room in
 * its URL (`getBackendSafeRoomName` in `react/features/base/util/uri.ts`): decode, NFKC, lower-case, URL-encode, then
 * lower-case again. The bot and the patient's link (`<jitsi url>/<encodeURIComponent(HN)>`) then always meet in the
 * same room, whatever characters the HN contains.
 *
 * The result is also safe to use as a single path segment, so evidence folders use it too.
 *
 * @param {string} hn - The patient's HN.
 * @returns {string}
 */
export function roomNameFromHn(hn: string): string {
    let room = hn;

    try {
        room = decodeURIComponent(room);
    } catch {
        // Not an encoded string; jitsi-meet carries on with it as it is.
    }

    return encodeURIComponent(room.normalize('NFKC').toLowerCase()).toLowerCase();
}
