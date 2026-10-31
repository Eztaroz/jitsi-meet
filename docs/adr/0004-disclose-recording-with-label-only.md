# Disclose recording with an in-call label only

Participants must know the consultation is recorded, but the recorder bot is hidden. We show a "recording" label in the call by having the bot advertise a recording session in its presence, which needs no fork change and no Jicofo involvement. We chose this over emulating Jibri's XMPP protocol (which would also bring the start sound, "started by" notification and consent dialog, but needs a moderator to trigger it and much more work) and over a fork change.

## Consequences

- There is no in-call consent prompt and no audible notice; any consent the hospital needs must be collected outside the call.
- The presence-only label path was confirmed by reading code, not by running it; the prototype must verify it.
