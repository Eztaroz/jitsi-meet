import { CONFERENCE_WILL_JOIN, NON_PARTICIPANT_MESSAGE_RECEIVED } from '../base/conference/actionTypes';
import { getCurrentConference } from '../base/conference/functions';
import MiddlewareRegistry from '../base/redux/MiddlewareRegistry';

import { CANCEL_MOVE, START_MOVE } from './actionTypes';
import { MOVE_CANCELLED_PROPERTY, MOVE_SUPPORT_PROPERTY } from './constants';
import { buildDestinationUrl, parseMove } from './functions';
import logger from './logger';

/** The pending departure of the move being counted down to. */
let departure: ReturnType<typeof setTimeout> | undefined;

MiddlewareRegistry.register(store => next => action => {
    const moving = store.getState()['features/coordinator-move'].move;
    const result = next(action);

    switch (action.type) {
    case CONFERENCE_WILL_JOIN:
        // Tells the server this client obeys move commands. It is set before the join, so that it is in the first
        // presence: the server refuses a client that does not announce it (ADR 0010).
        action.conference.setLocalParticipantProperty(MOVE_SUPPORT_PROPERTY, 'true');
        break;
    case NON_PARTICIPANT_MESSAGE_RECEIVED: {
        // Only a message from the server itself is a move command: it comes from the room's own address, which has
        // no resource, so the sender id is empty. A message from an occupant carries that occupant's id; ignore
        // it, so that no participant can move another.
        if (action.id) {
            break;
        }

        const move = parseMove(action.json);

        if (!move) {
            break;
        }

        logger.info('being moved to another room');
        store.dispatch({ endsAt: Date.now() + move.countdownSeconds * 1000, move, type: START_MOVE });

        clearTimeout(departure);
        departure = setTimeout(() => {
            const { audio, video } = store.getState()['features/base/media'];

            window.location.assign(buildDestinationUrl(window.location.href, move, {
                audio: Boolean(audio.muted),
                video: Boolean(video.muted)
            }));
        }, move.countdownSeconds * 1000);
        break;
    }
    case CANCEL_MOVE:
        // The participant stays. The server learns it from their presence.
        clearTimeout(departure);
        departure = undefined;
        if (moving) {
            getCurrentConference(store.getState())?.setLocalParticipantProperty(MOVE_CANCELLED_PROPERTY, moving.moveId);
        }
        break;
    }

    return result;
});
