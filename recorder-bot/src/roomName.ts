/**
 * Derives the conference room from a patient's HN with exactly the normalisation jitsi-meet applies to the room in
 * the patient's link, `<jitsi url>/<encodeURIComponent(HN)>` (`getBackendSafeRoomName` in
 * `react/features/base/util/uri.ts`): it decodes the link's segment, which gives back the HN itself, then applies
 * NFKC, lower-case, URL-encode, then lower-case again. The bot and the patient then always meet in the same room,
 * whatever characters the HN contains, "%" included.
 *
 * The result is also safe to use as a single path segment, so evidence folders use it too.
 *
 * @param {string} hn - The patient's HN.
 * @returns {string}
 */
export function roomNameFromHn(hn: string): string {
    return encodeURIComponent(hn.normalize('NFKC').toLowerCase()).toLowerCase();
}
