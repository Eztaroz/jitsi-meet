/**
 * `type` of the json-message the `mod_coordinator_api` Prosody module sends a participant to move them to another
 * room (ADR 0008). It is sent from the room's own address, so lib-jitsi-meet surfaces it as a
 * NON_PARTICIPANT_MESSAGE_RECEIVED: a message from the server, not from a participant.
 */
export const COORDINATOR_MOVE_MESSAGE_TYPE = 'coordinator_move';

/**
 * The local participant property (presence) by which this client says it obeys move commands. The server refuses
 * clients that do not announce it, so that everyone in a room can always be moved (ADR 0010).
 */
export const MOVE_SUPPORT_PROPERTY = 'coordinatorMoveSupport';

/** How long the notice counts down when the server does not say, in seconds. */
export const DEFAULT_COUNTDOWN_SECONDS = 5;
