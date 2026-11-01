# Moves require tokens, and each move carries a token for its destination

A move has to know which participant is the patient (a room holds at most one, and a station stops recording when its patient leaves), and the moved participant has to be let into a room their token does not name. Moves therefore need a deployment where everyone, patients included, joins with a token from the hospital's issuer carrying a role marker; deployments without tokens can still run the recorder bot, but not moves. Each move command carries a short-lived token, issued by the coordinator service and valid for the destination room only, which Prosody accepts as a second issuer.

## Considered Options

- Tokens valid for every room (`room: "*"`) for everyone: rejected, because a patient could then join another patient's room by typing its HN. Staff tokens may still name every room.

## Consequences

- The coordinator service holds a signing key, and Prosody is configured to trust it; a leaked key lets its holder join any room, so it is kept like the hospital issuer's key.
