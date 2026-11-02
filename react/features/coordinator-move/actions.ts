import { CANCEL_MOVE } from './actionTypes';

/**
 * Cancels the move being counted down to: the participant stays where they are.
 *
 * @returns {{ type: CANCEL_MOVE }}
 */
export function cancelMove() {
    return { type: CANCEL_MOVE };
}
