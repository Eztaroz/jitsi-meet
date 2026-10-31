# Record consultations with a custom recorder bot, not Jibri

Telemedicine consultations must be recorded as evidence. We tried Jibri and could not get it working, so recording is done by our own recorder bot: a headless Chromium running lib-jitsi-meet that logs in on the hidden `recorder.<domain>` XMPP domain (so it gets no tile and no join notice), receives every participant's audio and video, and writes each remote track to its own file plus a join/leave timeline. Background research: `doc/recorder-bot-research.md`.

## Considered Options

- **Jibri**: tried and failed in our deployment; screen-records one composite MP4 per instance and depends on Xvfb, ALSA loopback and ffmpeg.
- **JVB media export + `jitsi-multitrack-recorder`**: no participant needed, but audio only; JVB does not export video.
- **Non-browser WebRTC client**: would re-implement lib-jitsi-meet's XMPP/Jingle/Colibri handling with no upstream reference.

## Consequences

- "Hidden" means hidden from the UI only: Jicofo and JVB treat the bot as a full participant, so it keeps the conference alive and counts towards participant limits.
- The bot needs its own Prosody/Jicofo configuration (recorder VirtualHost, `token_verification_allowlist`, `muc_lobby_whitelist`, Jicofo `trusted-domains`, `hiddenDomain`).
- End-to-end encryption cannot be enabled, since the bot must decode the media it records.
