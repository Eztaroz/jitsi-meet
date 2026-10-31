# Disclose recording with an in-call label only

Participants must know the consultation is recorded, but the recorder bot is hidden. We show a "recording" label in the call by having the bot advertise a recording session in its presence, which needs no fork change and no Jicofo involvement. We chose this over emulating Jibri's XMPP protocol (which would also bring the start sound, "started by" notification and consent dialog, but needs a moderator to trigger it and much more work) and over a fork change.

## Consequences

- There is no in-call consent prompt and no audible notice; any consent the hospital needs must be collected outside the call.
- The prototype confirmed the path works (`resources/prototype-recorder-capture/README.md` on branch `prototype/recorder-bot-capture`), with one requirement. The bot must re-send its presence shortly after each participant joins. Otherwise a joiner can process the bot's presence before jitsi-meet starts listening for recorder state, and that joiner never sees the label.
