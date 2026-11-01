# Moves go through a Prosody module, driven by a separate coordinator service

A move must work across conferences and must not be something a participant can forge, so it is issued by the server rather than by another participant's client. A new Prosody module exposes an internal HTTP endpoint, authenticated with a system token like `mod_muc_kick_participant`, that lists open rooms and their occupants and sends a participant a move command; the fork's client obeys move commands only when they come from the server, and leaves for the new room. A separate coordinator service owns encounters, stages and queues, serves the coordinator's screen and the hospital system's API, and calls Prosody and the recorder bot.

## Consequences

- The hospital's room-creation system calls the coordinator service, not the recorder bot: the coordinator service starts the encounter and then asks the recorder bot to record.
- Moving someone to a room that is not open first asks the recorder bot to record it, and gives up if the recorder bot is at capacity or not ready within 30 seconds.
- Moves need the fork's web client; mobile apps ignore them until they get the same support.
