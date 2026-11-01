import { COORDINATOR_MOVE_MESSAGE_TYPE, DEFAULT_COUNTDOWN_SECONDS } from './constants';
import { IMove } from './types';

/**
 * Reads a move command from a message.
 *
 * @param {unknown} json - The json of a message from the server.
 * @returns {IMove|undefined} Undefined when it is not a well-formed move command.
 */
export function parseMove(json: any): IMove | undefined {
    if (json?.type !== COORDINATOR_MOVE_MESSAGE_TYPE
            || typeof json.destination !== 'string' || !json.destination
            || typeof json.token !== 'string' || !json.token
            || typeof json.moveId !== 'string') {
        return undefined;
    }

    const seconds = Number(json.countdownSeconds);

    return {
        countdownSeconds: seconds > 0 && seconds <= 60 ? seconds : DEFAULT_COUNTDOWN_SECONDS,
        destination: json.destination,
        moveId: json.moveId,
        token: json.token
    };
}

/**
 * Builds the address of the destination: the room beside the current one, entered with the destination token and
 * without the prejoin page, with the microphone and camera as they are now.
 *
 * @param {string} currentHref - The address of the current room.
 * @param {IMove} move - The move.
 * @param {Object} muted - Whether the microphone and the camera are muted.
 * @param {boolean} muted.audio - The microphone.
 * @param {boolean} muted.video - The camera.
 * @returns {string}
 */
export function buildDestinationUrl(currentHref: string, move: IMove, muted: { audio: boolean; video: boolean; }) {
    const url = new URL(currentHref);
    const segments = url.pathname.split('/');

    // The room is the last segment; a tenant, if any, comes before it.
    segments[segments.length - 1] = encodeURIComponent(move.destination);
    url.pathname = segments.join('/');
    url.search = `?jwt=${move.token}`;
    url.hash = [
        'config.prejoinConfig.enabled=false',
        `config.startWithAudioMuted=${muted.audio}`,
        `config.startWithVideoMuted=${muted.video}`
    ].join('&');

    return url.toString();
}
