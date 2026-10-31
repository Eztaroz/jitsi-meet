# PROTOTYPE: recorder bot capture (throwaway)

This is throwaway code. It answers one question and is not a starting point for production code. The decisions it settled are recorded in `docs/adr/` and `doc/recorder-bot-research.md` §5.

## Question

Can a hidden lib-jitsi-meet (LJM) client in headless Chromium do the following, without Jibri ([ADR 0001](../../docs/adr/0001-custom-recorder-bot-instead-of-jibri.md))?

- Stay invisible in the jitsi-meet UI.
- Record every remote audio and video track to its own file.
- Show the recording label through its presence alone ([ADR 0004](../../docs/adr/0004-disclose-recording-with-label-only.md)).
- Mark staff visits on a timeline.
- Stop by the ADR 0003 rule: leave when no human has been present for 60 s, or at once when the meeting is ended.

## Verdict

**Yes, with three changes to the planned design.**

| Check | Result |
|---|---|
| Bot hidden in UI | Absent from redux participants, the stage view and tile view, for both patient and staff. LJM still sees it (`isHidden() === true`). |
| Bot never moderator | It stays `participant` even when alone, because it advertises the Jibri feature and `recorder.meet.jitsi` is in Jicofo `trusted-domains`. The first human (the patient) gets moderator. |
| Per-track files | One WebM per remote track. The patient's audio is the 440 Hz tone, the staff's is 880 Hz, and neither has silence. Video frames show the right person. |
| Resolution changes | One file holds 360p → 720p → 180p → 720p runs, driven by the bot's receiver constraints, and decodes cleanly. |
| Label (presence only) | Shows in every view **after the fix below**. Without the fix it was missing in some runs. |
| Staff visit markers | `participant_joined` / `participant_left` events in `timeline.json`, for example a visit from 12.4 s to 28.8 s, then another from 40.0 s until the end. |
| Stop: meeting ended | `CONFERENCE_FAILED conference.destroyed` arrives. The bot starts stopping 63 ms after `end()` and all files are closed within 123 ms. |
| Stop: empty room | The bot leaves 60.0 s after the last human leaves. A rejoin inside the window cancels the timer. |

### Changes the design needs

1. **Attach remote audio to a muted `<audio>` element.** Without one, `MediaRecorder` writes **0 bytes** for remote audio (3 of 3 tracks in the `--no-attach-audio` run). Chromium does not pull remote WebRTC audio unless a sink consumes it. Video works without a sink.
2. **Re-send the bot's presence after each join.** jitsi-meet starts listening for `RECORDER_STATE_CHANGED` at `CONFERENCE_JOIN_IN_PROGRESS`, but LJM emits `PRESENCE_RECEIVED` before `MUC_JOIN_IN_PROGRESS` for the first presence it processes:
   - LJM: `lib-jitsi-meet@de80eae:modules/xmpp/ChatRoom.ts:856` then `:932`;
   - jitsi-meet: `react/features/recording/middleware.ts:393-397`.

   A joiner can therefore miss the bot's session. Jibri hides this because Jicofo keeps re-sending its presence.

   The bot now calls `conference.room.sendPresence()` 2 s after every `USER_JOINED`. `_handleJibriPresence` emits on every presence (`RecordingManager.ts:300-323`).
   - Before the fix, the label was missing in 3 of 3 views in one run.
   - After the fix, it was present in 6 of 6 views over 2 runs.

   The exact trigger of the race is inferred from code, not traced.
3. **Remux each file when it closes.** `MediaRecorder` WebM has no duration (`ffprobe` reports `N/A`). `ffmpeg -i in.webm -c copy out.webm` restores it; the result is within 0.2 s of wall-clock for audio. Video starts at its first frame, about 1 to 1.5 s after the track appears. ffmpeg warns about duplicate DTS on raw video files; decoding is unaffected.

### Other findings

- **Cost.** Recording 2 × 720p video and 2 audio tracks took about **2 CPU cores (207 % of one core) and 750 MB RSS** for the bot's Chromium tree. This was on a shared 4-vCPU sandbox, with a 15 fps synthetic source and no GPU. `MediaRecorder` re-encodes, so plan on about one core per 720p video track.
- **Storage.** File size follows `videoBitsPerSecond` (1.5 Mbps cap). The patient's file averaged about 0.96 Mbps over a mix of 720p and 180p. The ADR 0003 estimate (about 680 MB per 30-minute consultation) holds as an upper bound.
- **Rejoins create new files.** Each join is a new endpoint ID, so a rejoin starts new files. Post-processing must group files by identity. In production that identity should come from the JWT, not the display name.
- **Moderator in production.** In this anonymous test stack the patient becomes moderator, so the test hands moderator to staff before staff ends the meeting. Production needs staff logins (JWT) so that staff are moderators.
- **Leaving a destroyed room.** After the room is destroyed, `conference.leave()` waits about 5 s before it gives up. The files are already closed by then, so a production bot can skip `leave()` in that case.
- **Bot login.** The bot logs in as `recbot@recorder.meet.jitsi` over the `meet.jitsi` websocket endpoint; Prosody routes the stream by its `to` host. The bot's extdisco (STUN/TURN credential) requests fail with `service-unavailable`. That is harmless here, because media goes through JVB.
- **Do not override prejoin in links.** Overriding `config.prejoinConfig.enabled` in the URL hash makes jitsi-meet join **without camera and microphone** ("implies starting without media"). Hospital join links must not set it.
- **Serve the bot page from the Jitsi origin.** Here the page comes from Playwright route interception, which needs `--disable-features=LocalNetworkAccessChecks`. A production bot should serve it from the Jitsi origin instead.

### Not tested

- 30-minute recordings.
- Real networks and packet loss.
- Several rooms per bot instance.
- Crash and restart gaps.
- Mobile clients.
- JWT auth and lobby.
- E2EE, which a server-side bot cannot record.
- Upload to hospital storage.
- Clock alignment of files when composing them.

### Version caveat

The stack ran the Docker Hub `jitsi/*:stable` images: web 1.0.9268, LJM `341009ce`, Jicofo 1.0.1183 and JVB 2.3.295. That is not a build of this repo's `master`; GHCR images could not be pulled from the sandbox.

The label race is analysed against current upstream code, which has the same structure. Re-check the label against the hospital's own build.

## Layout

| Path | What |
|---|---|
| `stack/docker-compose.yml` | Upstream `docker-jitsi-meet@6bb51e6` compose file, changed to run the older Docker Hub images: `read_only`/`tmpfs` removed (s6-overlay v2 needs a writable root) and web ports mapped to 80/443. |
| `stack/.env` | Local test settings: P2P off, recording on (creates the hidden VirtualHost and the `recbot` account), JVB advertised on 127.0.0.1, IPv6 off. The passwords are local throwaway values. |
| `bot/run-bot.js` | Node + Playwright runner. Launches headless Chromium, loads LJM from the web container, writes the WebM files and `timeline.json`. |
| `bot/bot-page.js` | The bot itself, running in the page: login, hidden join, Jibri feature, label presence, receiver constraints, one `MediaRecorder` per track, stop rule. |
| `test/run-test.js` | Drives patient and staff through the real web UI with fake media. Scenarios `visit` and `grace`. |
| `test/verify.py` | Checks durations, decode, resolution runs and tone per file; lists staff visits and the stop reason. |

## Run

Requires Docker, Node with Playwright and Chromium, ffmpeg, and Python 3 with numpy.

1. Start the stack. `CONFIG` holds generated state; keep it outside the repo.

   ```bash
   cd resources/prototype-recorder-capture/stack && CONFIG=/tmp/jitsi-cfg docker compose up -d web prosody jicofo jvb
   ```

2. Make the fake media: a 720p MJPEG and a 16-bit WAV tone per person.

   ```bash
   mkdir -p /tmp/fake-media && cd /tmp/fake-media && ffmpeg -f lavfi -i "testsrc2=size=1280x720:rate=15" -t 10 -q:v 5 -f mjpeg patient.mjpeg && ffmpeg -f lavfi -i "smptehdbars=size=1280x720:rate=15" -t 10 -q:v 5 -f mjpeg staff.mjpeg && ffmpeg -f lavfi -i "sine=frequency=440:sample_rate=48000" -t 10 -ac 1 -c:a pcm_s16le patient.wav && ffmpeg -f lavfi -i "sine=frequency=880:sample_rate=48000" -t 10 -ac 1 -c:a pcm_s16le staff.wav
   ```

3. Run both scenarios. This takes about 3 minutes.

   ```bash
   node resources/prototype-recorder-capture/test/run-test.js all --media /tmp/fake-media --out /tmp/rec-out
   ```

4. Check each bot output folder.

   ```bash
   for d in /tmp/rec-out/hn*/; do python3 -I resources/prototype-recorder-capture/test/verify.py "$d"; done
   ```

5. To reproduce the audio finding, add `BOT_EXTRA_ARGS="--no-attach-audio"` to step 3.

To run the bot alone against a room: `node bot/run-bot.js --room <name> --out <dir> [--grace-ms 60000] [--max-height 720]`.
