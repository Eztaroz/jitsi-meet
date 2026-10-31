# Recorder bot without Jibri: feasibility research

Research date: 2026-10-31. Scope: a server-side bot for a self-hosted Jitsi Meet deployment (Prosody, Jicofo, JVB, `jitsi-meet-tokens`, lobby). The bot records every participant in a telemedicine room as evidence. It joins without a tile and joins when the room is created. Participants are told about the recording. The bot must never record covertly. This document does not cover ways to hide the recording itself.

Room model assumed throughout: one room per patient, named after the patient's HN. The patient stays in the room and staff join and leave.

## How to read the citations

- This repo (HEAD `ef42f1d`): `path:line`, relative to the repo root.
- Upstream: `repo@<short-sha>:path:line`. The repos are shallow clones taken on 2026-10-31:

  | Repo | Commit | Commit date |
  |---|---|---|
  | `lib-jitsi-meet` (LJM) | `de80eae` | 2026-10-30 |
  | `jicofo` | `ef69ab6` | 2026-10-29 |
  | `jitsi-videobridge` (JVB) | `2bfa5b4` | 2026-10-29 |
  | `jibri` | `e05e116` | 2026-10-27 |
  | `jitsi-xmpp-extensions` | `dd02a91` | 2026-10-28 |
  | `jitsi-multitrack-recorder` | `b489119` | 2026-07-21 |
  | `jigasi` | `3a2789a` | 2026-10-28 |
  | `docker-jitsi-meet` | `6bb51e6` | 2026-10-23 |
  | `handbook` | `a337568` | 2026-10-13 |

- Handbook: the published URL plus `handbook@a337568:<source path>`. I built the URLs from `docusaurus.config.js:4-5` (`url`, `baseUrl`) and each page's front-matter `id`. I did not fetch them; see [Unverified](#5-unverified).

---

## 1. Summary

- **Verdict: feasible without Jibri.** Jibri's "hidden" participant is not a Jibri feature. It is a generic mechanism, a separate XMPP domain set as `config.hiddenDomain`, and any XMPP client can use it. A custom bot that logs in on `recorder.<domain>` is filtered out of the participant list and tiles exactly like Jibri ([§2.1](#21-hidden-participant)).
- **"Hidden" only means hidden from the UI.** Jicofo and JVB treat the bot as a full participant:
  - it gets a media session;
  - it counts for `min-participants` and the single-participant timeout;
  - it keeps the conference alive;
  - it counts towards `muc_max_occupants` unless whitelisted;
  - LJM counts it in the P2P decision ([§2.1.6](#216-what-the-hidden-bot-counts-towards)).
- **Recommended architecture: a browser bot.**
  - **Runtime:** headless Chromium running lib-jitsi-meet. The UI-less client in `react/features/load-test/` is the template.
  - **Login:** `recbot@recorder.<domain>` with a password.
  - **Join config:** P2P off, SSRC rewriting off, no local tracks.
  - **Receive config:** receiver constraints with `lastN: -1` and an explicit per-source `maxHeight`.
  - **Recording:** each remote audio and video track is recorded separately with `MediaRecorder` into WebM files, alongside a JSON join/leave/track timeline.
  - **What it avoids:** Xvfb, ALSA loopback and ffmpeg screen capture, which Jibri needs because it records the screen.
  - Details in [§2.2.1](#221-option-a-headless-chromium--ljm--mediarecorder-per-track-recommended).
- **No upstream server-side component records video.**
  - JVB's media export ("connects") throws `FeatureNotImplementedException("Video")` for video.
  - `jitsi-multitrack-recorder` writes audio-only, per-speaker MKA.
  - That pipeline is a usable audio-only fallback, but it does not meet the "audio and video" requirement ([§2.2.3](#223-option-b-jvb-media-export--jitsi-multitrack-recorder-audio-only)).
- **Disclosure: one no-fork path drives the whole existing UI.** The recording label, the start sound, the "X started recording" notification and the `requireConsent` dialog are all driven by Jicofo's `jibri-recording-status`. To trigger them without a fork, the bot service must speak the Jibri XMPP control protocol to Jicofo.
- **Cheaper disclosure paths give partial UI:**
  - a presence-only shortcut (`session_id` + `mode=file` in the bot's presence) shows the label only;
  - a `localRecording` participant property shows a toast and plays a sound, with no lasting label;
  - a small fork change can add a label tied to the bot ([§2.3](#23-notifying-participants)).
- **Join at room creation: no stock webhook exists.**
  - Simplest option: the hospital system starts the bot when it issues the room link, and the bot's own join creates the room.
  - Server-side options: a small Prosody module hooking `muc-room-created` (the handbook uses this pattern), or `mod_reservations`, which already POSTs to an HTTP API before a room is created ([§2.4](#24-joining-when-the-room-is-created)).
- **Prosody/Jicofo changes the bot needs:**
  - a `recorder.<domain>` VirtualHost with `internal_hashed` authentication;
  - `token_verification_allowlist` (without it, a tokenless recorder session is rejected with `room-name-does-not-match`);
  - `muc_lobby_whitelist`;
  - `muc_access_whitelist` if `muc_max_occupants` is used;
  - Jicofo `xmpp.trusted-domains`, so the bot is classified as Jibri and never elected moderator;
  - `config.hiddenDomain` ([§2.5](#25-auth-and-lobby)).
- **The HN room name leaks widely.** It appears in the nginx access log path, the BOSH/WebSocket `room=` query parameter, Prosody, Jicofo and JVB logs, rtcstats identity and the JWT `room` claim. `brandingRoomAlias` changes only invite links, not the room name ([§2.6](#26-room-names-derived-from-hn)).
- **Biggest risks:**
  1. **Evidence gaps** during bot crashes or reconnects; with P2P enabled, two humans fall back to P2P when the bot is gone.
  2. **Per-track file integrity:** WebM from `MediaRecorder` and clock alignment across files.
  3. **Load on patient devices:** the bot's high-resolution receive constraints make every sender send high layers.
  4. **E2EE** makes server-side recording impossible.
  5. **Bot elected moderator:** a mis-configured bot (not trusted as Jibri) can be auto-elected moderator and receive lobby knock requests.
  6. **HN leakage** into logs.

---

## 2. Findings per question

### 2.1 Hidden participant

#### 2.1.1 How "hidden" is detected

1. **The client compares domains.** LJM marks a MUC occupant as hidden when the domain of its real JID equals `options.hiddenDomain`. In `lib-jitsi-meet@de80eae:modules/xmpp/ChatRoom.ts:847-860`:
   - the real JID comes from the `muc#user` `<item jid>`;
   - `isHiddenDomain = jid.indexOf('@') > 0 && options.hiddenDomain === domain`;
   - the result is emitted as `PRESENCE_RECEIVED { fromHiddenDomain, isFocus, presence }`.

   `MUC_MEMBER_JOINED` passes the same flag (lines 995-1025).
2. **Every occupant can see real JIDs.** Jicofo configures every room as non-anonymous (`muc#roomconfig_whois = anyone`) "so that others can recognize focus JID" (`jicofo@ef69ab6:jicofo-common/src/main/kotlin/org/jitsi/jicofo/xmpp/muc/ChatRoomImpl.kt:424-428`).
3. **The flag is stored on the participant.** `JitsiConference.onMemberJoined` creates a `JitsiParticipant` with the hidden flag and always adds it to `this.participants` (`lib-jitsi-meet@de80eae:JitsiConference.ts:4006-4047`; `JitsiParticipant.ts:24,89,294`).
4. **Where the setting comes from.** In this repo `hiddenDomain` is listed only as an "undocumented setting used in lib-jitsi-meet" (`config.js:1890-1901`, key at `config.js:1897`; type at `react/features/base/config/configType.ts:510`). Docker sets it from `XMPP_HIDDEN_DOMAIN` (`docker-jitsi-meet@6bb51e6:web/rootfs/defaults/settings-config.js:181`). The Jibri README shows `config.hiddenDomain` (`jibri@e05e116:README.md:253-281`).

#### 2.1.2 How jitsi-meet filters hidden participants

- `commonUserJoinedHandling` dispatches `participantJoined` only `if (!user.isHidden())`, so a hidden participant never enters Redux. As a result it gets no tile, no participants-pane entry and no join notification (`react/features/base/conference/functions.ts:89-117`, check at line 95). Leaving is filtered the same way at line 134.
- The legacy `USER_JOINED` / `USER_LEFT` handlers return early for hidden users (`conference.js:1417`, `conference.js:1434`).
- `membersCount`, "used by Jibri to detect when it's alone", leaves hidden users out (`conference.js:813-816`).
- When the local client itself is hidden (`conference.isHidden()`), it skips the display-name prompt (`react/features/base/conference/middleware.any.ts:439`).

#### 2.1.3 Prosody: `recorder.<domain>` VirtualHost and related options

The sample Prosody config in this repo already has the hidden host. It also has commented-out lobby and token knobs:

| Item | Where | Notes |
|---|---|---|
| Recorder VirtualHost | `doc/debian/jitsi-meet-prosody/prosody.cfg.lua-jvb.example:138-143` | `VirtualHost "recorder.jitmeet.example.com"`, `authentication = "internal_hashed"` |
| `muc_lobby_whitelist` | same file, line 81 | Commented example: "Here we can whitelist jibri to enter lobby enabled rooms" |
| `token_verification` | same file, line 91 | Commented out on the conference MUC |
| `restrict_room_creation = true` | same file, line 85 | On the conference MUC |

Jibri's README documents the same VirtualHost and registers `recorder@recorder.yourdomain.com` with `prosodyctl` (`jibri@e05e116:README.md:192-232`). Docker defines it too (`docker-jitsi-meet@6bb51e6:prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua:293-298`).

The Prosody plugins treat recorder JIDs as follows:

- **`recorder_prefixes`.** Jitsi's Prosody utilities identify "Jibri" occupants by JID prefix. The option defaults to `{ 'recorder@recorder.', 'jibria@recorder.', 'jibrib@recorder.' }` (`resources/prosody-plugins/util.lib.lua:39`), and `is_jibri()` checks it (`util.lib.lua:639-641`). Docker sets it to `<JIBRI_RECORDER_USER>@<XMPP_HIDDEN_DOMAIN>` (`docker-jitsi-meet@6bb51e6:prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua:81`).
- **Modules that use `is_jibri()`:**
  - `mod_muc_cleanup_backend_services.lua` (whole file, 1-82): when only jibri or transcriber occupants remain, it destroys the room after `services_empty_meeting_timeout` (default 20 s);
  - `mod_speakerstats_component.lua:237-238`;
  - `mod_visitors.lua:295,317,360`;
  - `mod_muc_meeting_id.lua:280`.
- **Choosing the bot's JID.** Name the account so that it matches `recorder_prefixes`, or extend the list, to get Jibri treatment in these modules. Whether you want the cleanup behaviour is a decision; see [§4](#4-open-decisions-for-the-owner).
- **`muc_lobby_whitelist`.** The lobby module reads the option (`resources/prosody-plugins/mod_muc_lobby_rooms.lua:111`). On `muc-occupant-pre-join` into a members-only room (lobby on), it grants `member` affiliation to an occupant whose domain or bare JID is whitelisted (lines 583-617). It returns before the display-name check (lines 625-633).
- **`muc_access_whitelist`.** Occupants listed by domain or JID are not counted against `muc_max_occupants` or the per-room `max_occupants` (`resources/prosody-plugins/mod_muc_max_occupants.lua:13,31-38,52-58`). Docker whitelists the recorder JID there (`docker-jitsi-meet@6bb51e6:prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua:400-407`).

#### 2.1.4 How Jicofo treats hidden participants

1. **Jicofo has no notion of "hidden".** It classifies members by two inputs (`jicofo@ef69ab6:jicofo-common/src/main/kotlin/org/jitsi/jicofo/xmpp/muc/ChatRoomMemberImpl.kt:169-200`):
   - the `<features>` element in presence (`http://jitsi.org/protocol/jibri`);
   - whether the JID domain is in `jicofo.xmpp.trusted-domains`.

   The rule is `isJibri = jibriSignaled && jidTrusted`. A Jibri feature from an untrusted domain is logged as a warning and ignored. `trusted-domains` defaults to `[]` and is described as "Only members logged in to these domains can declare themselves to be Jibri instances" (`jicofo@ef69ab6:jicofo-common/src/main/resources/reference.conf:210-212`). Docker fills it with the hidden domain when recording or transcription is enabled (`docker-jitsi-meet@6bb51e6:jicofo/rootfs/defaults/jicofo.conf:44,349`).
2. **What `isJibri` changes:**
   - auto-owner election skips `isJibri || isJigasi` (`jicofo@ef69ab6:jicofo/src/main/kotlin/org/jitsi/jicofo/xmpp/muc/ChatRoomRoleManager.kt:62-110`; `enable-auto-owner = true` at `jicofo@ef69ab6:jicofo/src/main/resources/reference.conf:21`);
   - client requirement checks are skipped (`jicofo@ef69ab6:jicofo/src/main/kotlin/org/jitsi/jicofo/conference/ClientRequirementsHandler.kt:81-84`);
   - the member is left out of `getUserParticipantCount`, which the visitors soft limit uses (`jicofo@ef69ab6:jicofo/src/main/java/org/jitsi/jicofo/conference/JitsiMeetConferenceImpl.java:2151-2169,2180-2193`).
3. **How the bot declares the feature.** LJM `JitsiConnection.addFeature(feature, external=true)` puts a `<features><feature var=…/></features>` element into MUC presence (`lib-jitsi-meet@de80eae:modules/xmpp/Caps.ts:207-247`; `JitsiConnection.ts:217-218`). jitsi-meet does exactly this for `iAmRecorder` with `DISCO_JIBRI_FEATURE = 'http://jitsi.org/protocol/jibri'` (`react/features/base/connection/middleware.web.ts:10-20`).
4. **What `isJibri` does not change.** The bot is still invited to a Jingle session and still counts as a member everywhere else (see the table in [§2.1.6](#216-what-the-hidden-bot-counts-towards)).

#### 2.1.5 Can a custom bot use the same mechanism?

Yes. Nothing in the chain checks that the client is Jibri:

- LJM checks only the JID domain;
- Prosody checks only domain or prefix lists;
- Jicofo checks only the presence feature plus `trusted-domains`.

Jibri itself is just a Chrome page that loads jitsi-meet with `config.iAmRecorder=true` and logs in with the recorder credentials (`jibri@e05e116:src/main/kotlin/org/jitsi/jibri/selenium/JibriSelenium.kt:157-169`; credentials injected via `react/features/base/connection/actions.web.ts:46-56`).

A custom LJM client calls `connection.connect({ id, password })` with `recbot@recorder.<domain>` (`lib-jitsi-meet@de80eae:JitsiConnection.ts:108-121`) and gets the same treatment. Jigasi uses the same pattern for its transcriber (`jigasi@3a2789a:jigasi-home/sip-communicator.properties:59-63,166-171`).

#### 2.1.6 What the hidden bot counts towards

| Mechanism | Counts the hidden bot? | Source |
|---|---|---|
| jitsi-meet participant list, tiles, join toasts | No | `react/features/base/conference/functions.ts:95`; `conference.js:1417` |
| LJM `getParticipants()` | Yes | `lib-jitsi-meet@de80eae:JitsiConference.ts:3788`, `4006-4047` |
| LJM `getParticipantCount()` | No by default (`countHidden=false`) | `lib-jitsi-meet@de80eae:JitsiConference.ts:3798-3806` |
| LJM P2P decision `_shouldBeInP2PMode` | **Yes**: it uses `getParticipants()` and only excludes `poltergeist`/Jigasi bot types | `lib-jitsi-meet@de80eae:JitsiConference.ts:1460-1476` |
| Jicofo `min-participants` (default 2) before media sessions start | **Yes**: it counts MUC members | `jicofo@ef69ab6:jicofo/src/main/java/org/jitsi/jicofo/conference/JitsiMeetConferenceImpl.java:1103-1124`; `reference.conf:39` |
| Jicofo single-participant timeout (20 s) | **Yes**: patient + bot means two participants, so no timeout | `JitsiMeetConferenceImpl.java:1152-1190`, `2568-2586`, `2922-2960`; `reference.conf:36` |
| Jicofo conference stop | Stops only when the MUC is empty, so the bot keeps it alive | `JitsiMeetConferenceImpl.java:1197-1221` |
| Jicofo auto-owner election | Excluded only if `isJibri` (feature + trusted domain) | `ChatRoomRoleManager.kt:62-110` |
| Jicofo user count (visitors soft limit) | Excluded only if `isJibri` | `JitsiMeetConferenceImpl.java:2180-2193` |
| Prosody `muc_max_occupants` | Yes, unless in `muc_access_whitelist` | `resources/prosody-plugins/mod_muc_max_occupants.lua:31-35,52-58` |
| Prosody `mod_muc_cleanup_backend_services` | If the JID matches `recorder_prefixes`, a room left with only the bot is destroyed after 20 s | `resources/prosody-plugins/mod_muc_cleanup_backend_services.lua:1-82` |

**What this means for the patient-room model:**

- If the bot is not treated as Jibri by `mod_muc_cleanup_backend_services` (or that module is not loaded), the bot alone keeps the MUC alive.
- If the patient leaves and the bot is the only participant, Jicofo's single-participant timeout ends the bot's media session after 20 s (`SinglePersonTimeout`, `JitsiMeetConferenceImpl.java:2922-2960`). The MUC stays.
- Media sessions start again when a second member joins. That is consistent with `checkMinParticipants`, but I did not test the re-invite path.

### 2.2 Receiving everyone's media

#### 2.2.1 Option A: headless Chromium + LJM + `MediaRecorder` per track (recommended)

**Prior art in this repo:**

- **`react/features/load-test/`** is a UI-less LJM client. It is built only by `npm run build:load-test` (`webpack.config.js:404-413`). `loadTestParticipant.ts:1-112` takes config overrides, a JWT and `remoteAudio`/`remoteVideo` parameters. `LoadTestClient.ts`:
  - creates `new JitsiMeetJS.JitsiConnection(null, jwt, config)` (line 594);
  - calls `initJitsiConference(roomName.toLowerCase(), config)` (line 610);
  - listens for `TRACK_ADDED` (`onRemoteTrack`, 406-431);
  - joins with no local tracks when no devices are wanted (636-641);
  - sends receiver constraints with `defaultConstraints.maxHeight` and `lastN` from config through `room.setReceiverConstraints` (150-211).

  This is close to the skeleton a recorder bot needs.
- **Malleus** (`tests/malleus/README.md:44-66`) drives that client for load tests. It has a "lite mode" in which receivers do not decode media, and it emulates receiver constraints. It is a test harness, not a recorder.
- **`MediaRecorder` usage** already exists for local recording. `react/features/recording/components/Recording/LocalRecordingManager.web.ts` uses `PREFERRED_MEDIA_TYPE = 'video/webm;codecs=vp8,opus'` (line 51), `new MediaRecorder(...)` (line 250) and `start(5000)` (line 328).

**What the bot must configure to receive everyone at usable quality:**

1. **Receiver constraints.** These are the JVB's only input for what to forward to an endpoint (`jitsi-videobridge@2bfa5b4:doc/allocation.md:27-59`).
   - JVB defaults: `initial-max-height-px = 0` (forward no video until the client sends constraints), `default-max-height-px = 180`, `onstage-preferred-height-px = 360` (`jitsi-videobridge@2bfa5b4:jvb/src/main/resources/reference.conf:46-56`).
   - The bot must call `conference.setReceiverConstraints({ lastN: -1, defaultConstraints: { maxHeight: H }, constraints: {...} })` early (`lib-jitsi-meet@de80eae:JitsiConference.ts:5030-5049`). Otherwise it receives no video, or 180p.
   - `allocation.md` notes that with spare bandwidth the bridge may exceed a positive constraint, and that `0` means "never forward".
2. **Last-N.** `jvb-last-n = -1` and `initial-last-n = -1` by default (`jitsi-videobridge@2bfa5b4:jvb/src/main/resources/reference.conf:72-78`). A load-based last-N reducer and `conference-last-n-limits` exist (lines 215-237) and must stay off or high enough. LJM `setLastN` is at `JitsiConference.ts:3762`.
3. **Audio.** `loudest.route-loudest-only = false` by default: "If false, all audio is forwarded" (`jitsi-videobridge@2bfa5b4:jvb/src/main/resources/reference.conf:373-391`). If an operator turns it on, the bot receives only the loudest speakers. LJM also has `setAudioSubscriptionMode` (`JitsiConference.ts:3749`).
4. **Bandwidth.** The video layer chosen depends on the bot's estimated downlink. LJM `setAssumedBandwidthBps` (`JitsiConference.ts:5057`) only takes effect up to the bridge's `assumed-bandwidth-limit`, which is commented out by default (`jitsi-videobridge@2bfa5b4:jvb/src/main/resources/reference.conf:80-82`).
5. **Simulcast.** Jicofo strips simulcast from receivers' offers (`strip-simulcast = true`) and the bridge picks the layer (`jicofo@ef69ab6:jicofo/src/main/resources/reference.conf:60-75`). **Side effect:** the bridge tells each sender the largest height any receiver needs (`jitsi-videobridge@2bfa5b4:doc/constraints.md:1-18`). A bot that asks for 720p from everyone makes every sender, including the patient's phone, send its high layer at all times.
6. **SSRC rewriting: leave it off in the bot.**
   - jitsi-meet turns it on by default (`ssrcRewritingEnabled: true`, `react/features/base/connection/actions.any.ts:163-168`), and so does Jicofo (`use-ssrc-rewriting = true`, `jicofo@ef69ab6:jicofo/src/main/resources/reference.conf:68`).
   - LJM only advertises `http://jitsi.org/ssrc-rewriting-1` when the flag is set; the default is false (`lib-jitsi-meet@de80eae:modules/flags/FeatureFlags.ts:16-28,69-71`; `modules/xmpp/xmpp.ts:500-508`).
   - With rewriting, a remote track object can be remapped to a different participant (`JitsiRemoteTrack.setOwner`, "Update the properties when the track is remapped to another source", `lib-jitsi-meet@de80eae:modules/RTC/JitsiRemoteTrack.ts:507-515`; owners are cleared on leave at `JitsiConference.ts:4095-4116`). That would mix two people into one per-track file. A bare LJM bot that does not set the flag avoids this.
7. **No local media.** Jibri joins with `startWithAudioMuted`, `startWithVideoMuted` and `disableInitialGUM` (`JibriSelenium.kt:157-169`). The load-test client joins without local tracks (`LoadTestClient.ts:636-641`).

**Output format.** One WebM file per remote track (VP8 or VP9/H.264 depending on what Chromium's `MediaRecorder` supports; the repo uses `video/webm;codecs=vp8,opus`). A composite (picture-in-picture) file would have to be made afterwards, for example with ffmpeg, or by drawing to a canvas in the page.

**Dependencies.**

- Chromium (headless) plus a driver such as Puppeteer or Playwright, or Selenium as Jibri uses.
- The LJM bundle served from the deployment.
- A small Node or Java control service for start/stop, upload and the timeline.
- No Xvfb or ALSA loopback is expected, because nothing is screen-captured. **Unverified:** whether headless Chromium plays and records remote WebRTC audio with no audio device.

**Capacity.** No primary source gives numbers for this design.

#### 2.2.2 For comparison: Jibri's approach

- **How it records:** Chrome in a virtual framebuffer with ffmpeg screen capture, and "only one recording at a time is supported on a single jibri" (`jibri@e05e116:README.md:9-12`).
- **Host setup:** it needs the ALSA `snd_aloop` loopback (`README.md:28-38`).
- **ffmpeg defaults:** `recording-format = "mp4"`, x11grab input, `audio-source = "alsa"`, `audio-device = "plug:bsnoop"` (`jibri@e05e116:src/main/resources/reference.conf:83-122`).
- **Newer releases:** the Docker handbook says the ALSA loopback module is needed only "if you are using a release older than 7439" (https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker, `handbook@a337568:docs/devops-guide/docker.md:452-470`). I did not trace what replaced it.
- **Output:** one composite MP4 of what the page shows, not per-person tracks.

#### 2.2.3 Option B: JVB media export + `jitsi-multitrack-recorder` (audio only)

- **Audio only.** JVB can export media over a WebSocket ("colibri2 connects"), but the code rejects video: `if (connect.video) throw FeatureNotImplementedException("Video")` (`jitsi-videobridge@2bfa5b4:jvb/src/main/kotlin/org/jitsi/videobridge/export/ExporterWrapper.kt:206`). The exporter's `wants()` accepts only `AudioRtpPacket` (`.../export/Exporter.kt:214-234`). The REST doc example shows `"video": true` (`jitsi-videobridge@2bfa5b4:doc/rest-colibri2.md:113-116`), which contradicts the code.
- **Connect types:** RECORDER, TRANSCRIBER, TRANSLATOR and AGENT (`jitsi-xmpp-extensions@dd02a91:src/main/kotlin/org/jitsi/xmpp/extensions/colibri2/Connect.kt:204-211`).
- **Jicofo creates connects only for transcription** (TRANSCRIBER type, `jicofo@ef69ab6:jicofo-selector/src/main/kotlin/org/jitsi/jicofo/bridge/colibri/ColibriV2SessionManager.kt:540-562`), translator and agent:
  - the URL comes from `jicofo.transcription.url-template`, whose own commented example is `"wss://{{REGION}}.example.com/recorder/{{MEETING_ID}}"` (`jicofo@ef69ab6:jicofo-selector/src/main/resources/reference.conf:124-128`);
  - it starts when room metadata has `recording.isTranscribingEnabled && asyncTranscription` (`jicofo@ef69ab6:jicofo-common/src/main/kotlin/org/jitsi/jicofo/xmpp/muc/ChatRoomImpl.kt:480-488`).
- **The handbook describes this path** as JVB forwarding "each participant's Opus audio" to a WebSocket service (https://jitsi.github.io/handbook/docs/devops-guide/transcription, `handbook@a337568:docs/devops-guide/transcription.md:1-18`):
  - `asyncTranscription` is a server-only metadata key;
  - the page gives a sample Prosody module that sets it on `muc-room-created` (`transcription.md:175-200`);
  - the key is blocked for clients in `resources/prosody-plugins/mod_room_metadata_component.lua:106-123`.
- **`jitsi-multitrack-recorder` is the receiving end.** Its README: "Exposes a websocket on :8989/record which can receive audio data from the jitsi videobridge. Records the audio in multi track mka format" (`jitsi-multitrack-recorder@b489119:README.md:1-3`). The WebSocket route is `/record/{meetingid}` (`src/main/kotlin/org/jitsi/recorder/Main.kt:65`), and the config covers format `mka`, port 8989 and a `finalize-script` (`src/main/resources/reference.conf`; `Config.kt:28-73`).
- **It keeps working when the patient is alone.** With an active connect, Jicofo drops `min-participants` to 1 and skips the single-participant timeout (`JitsiMeetConferenceImpl.java:1103-1124,2922-2960`).
- **Disclosure side effect:** Jicofo sets the `audio-recording-enabled` conference property (`JitsiMeetConferenceImpl.java:2764-2772`).
  - jitsi-meet maps it to `isTranscribing` (`react/features/transcribing/reducer.ts:48-61`).
  - When metadata `recording.isTranscribingEnabled` is also set, clients show the transcribing label, "This meeting is being transcribed." (`react/features/transcribing/functions.ts:117-121`; `react/features/recording/components/web/TranscribingLabel.tsx:88-95,118-121`; `lang/main.json:1673`).
  - So this path does disclose something, but the wording says transcription, not recording.
- **Output:** per-speaker Opus audio in MKA, no video.

#### 2.2.4 Option C: Jigasi transcriber with `RECORD_AUDIO` (audio only, deprecated path)

- Jigasi's transcriber can "record audio. Currently only wav format is supported" (`jigasi@3a2789a:jigasi-home/sip-communicator.properties:252-254`; implementation in `src/main/java/org/jitsi/jigasi/transcription/AbstractTranscriptPublisher.java:66-77,673-700`). The output is mixed WAV.
- The handbook says Jigasi transcription is **deprecated** in favour of the bridge path (`handbook@a337568:docs/devops-guide/transcription.md:20-26`).

#### 2.2.5 Option D: a non-browser WebRTC stack

- **What it must implement:** a non-browser participant must speak XMPP MUC, Jingle with Jitsi's source signalling, and Colibri over WebSocket to JVB (for receiver constraints), then decode or store RTP.
- **Upstream reference:** Jitsi's only non-browser participant is Jigasi (Java/libjitsi), with a `FeaturesExtension` in presence at `jigasi@3a2789a:src/main/java/org/jitsi/jigasi/JvbConference.java:224`. I found no Jitsi-maintained SDK for a headless non-browser client.
- **Assessment:** possible, but it means re-implementing what LJM already does. I found no primary source on effort or capacity.

#### 2.2.6 P2P

1. **Hidden participants count for P2P.** LJM's `_shouldBeInP2PMode` counts all participants, hidden ones included. It needs exactly one peer that is not a `poltergeist`/Jigasi bot (`lib-jitsi-meet@de80eae:JitsiConference.ts:1460-1476`). So **patient + staff + bot = 2 peers for each human, and the conference runs on JVB.**
2. **Patient + bot alone: one peer, so P2P is attempted.** A bot configured with `p2p.enabled=false` declines the incoming P2P session (`_onIncomingCallP2P`, `JitsiConference.ts:1826-1860`). Jibri sets `config.p2p.enabled=false` the same way (`JibriSelenium.kt:157-169`).
3. **If the bot drops out and two humans remain,** they become P2P candidates again (`_maybeStartOrStopP2P`, `JitsiConference.ts:1383-1452`). Media then bypasses JVB until the bot is back.
4. **Turning P2P off deployment-wide** (`p2p.enabled=false` in `config.js`) removes these transitions. That is an owner decision; see [§4](#4-open-decisions-for-the-owner).
5. **E2EE:** LJM disables P2P switching when E2EE is on (same function). E2EE also means a server-side bot receives media it cannot decrypt; see [Unverified](#5-unverified).

### 2.3 Notifying participants

#### 2.3.1 What drives the existing recording UI

| UI element | Trigger | Source |
|---|---|---|
| Recording label | A FILE session with status ON or PENDING (`isRecordingRunning`), or a remote participant recording locally | `react/features/recording/components/AbstractRecordingLabel.ts:80-95`; `react/features/recording/functions.ts:53-60,138-158,195-200,382-393` |
| Start sound + "X started recording" notification | (a) `startRecordingIntent`, which remote observers only get when room metadata `recording.isRecordingRequested` flips false→true; and (b) a FILE session ON **with an `initiator` and id** | `react/features/recording/middleware.ts:107-204` (initiator wait at 144-148), metadata listener at `middleware.ts:326-362`; start dialog writes metadata at `react/features/recording/components/Recording/AbstractStartRecordingDialog.ts:697-710` |
| Consent dialog (`recordings.requireConsent`) | `RECORDER_STATE_CHANGED`, then `shouldRequireRecordingConsent`: requires `requireConsent`, an **initiator**, status not OFF, and an initiator other than the local user. `_showExplicitConsentDialog` mutes local audio and video until the user acts | `react/features/recording/middleware.ts:393-412,704-726`; `react/features/recording/functions.ts:488-536` |
| Prejoin warning (`recordings.showPrejoinWarning`) | Static config only: "Other participants may be recording this call" | `config.js:471-490`; `react/features/prejoin/components/web/Prejoin.tsx:510,524`; `react/features/base/premeeting/components/web/PreMeetingScreen.tsx:264`; `lang/main.json:1180` |

**Where session state comes from.** LJM's `RecordingManager` builds sessions from two kinds of presence (`lib-jitsi-meet@de80eae:modules/recording/RecordingManager.ts:91-98`):

- **Focus (Jicofo) presence**, via `_handleFocusPresence` (237-291). It parses `<jibri-recording-status>` with `status`, `session_id`, `recording_mode`, `initiator` and `failure_reason` (`modules/recording/recordingXMLUtils.ts:27-41`).
- **Hidden-domain presence**, via `_handleJibriPresence` (300-323). It needs a `<session_id>` element and creates or updates a session with status `on` and the given `<mode>` (`recordingXMLUtils.ts:50-60`).

Only Jicofo supplies `initiator`. jitsi-meet's own comment says so: "We receive 2 updates of the session status ON. The first one is from jibri when it joins. The second one is from jicofo which will deliver the initiator value" (`react/features/recording/middleware.ts:526-531`, within the `RECORDING_SESSION_UPDATED` handler at 493-583).

#### 2.3.2 Path N1: the bot service speaks the Jibri XMPP protocol (full existing UI, no fork)

Jicofo does not care what software answers as "Jibri". The protocol, from primary sources:

1. **Brewery.** Jibri joins a brewery MUC with its control account and publishes `JibriStatusPacketExt` (idle/busy and health) (`jibri@e05e116:src/main/kotlin/org/jitsi/jibri/api/xmpp/XmppApi.kt:276-283`). Jicofo's `JibriDetector` watches the brewery and selects an available instance (`jicofo@ef69ab6:jicofo/src/main/kotlin/org/jitsi/jicofo/jibri/JibriDetector.kt:37-54,70-82,99-120`). The brewery JID and timeouts are set in Jicofo `jibri { brewery-jid, pending-timeout = 90s, … }` (`jicofo@ef69ab6:jicofo/src/main/resources/reference.conf:159-188`). Jibri's own control and call settings are described in `jibri@e05e116:doc/xmpp_api.md:1-9`.
2. **Start request from the room.** A client sends `<jibri action="start" recording_mode="file">` to focus. Jicofo accepts it only when it comes from the conference room JID (an occupant) (`jicofo@ef69ab6:jicofo/src/main/kotlin/org/jitsi/jicofo/jibri/BaseJibri.kt:150-158`). With `enable-moderator-checks = true` (default, `jicofo/src/main/resources/reference.conf:24`) the sender must be a moderator, and start requests are rate-limited (`BaseJibri.kt:168-239`).
3. **Prosody gate (if loaded).** `mod_filter_iq_jibri.lua` lets start/stop IQs through only when the sender's JWT `features` allow `recording`, or, if there are no features, when the sender is a moderator. It also rate-limits per IP and per room (`resources/prosody-plugins/mod_filter_iq_jibri.lua:1-88`).
4. **Jicofo → Jibri.** Jicofo creates a session with `initiator = iq.from` (`jicofo@ef69ab6:jicofo/src/main/kotlin/org/jitsi/jicofo/jibri/JibriRecorder.kt:91-146`). It sends a START IQ with session id, room, mode FILE and `appData` to the selected instance and expects `PENDING` (`jicofo@ef69ab6:jicofo/src/main/java/org/jitsi/jicofo/jibri/JibriSession.java:545-683`). `mod_jibri_session.lua` adds the initiator's id and group and the `meetingId` to `app_data` (`resources/prosody-plugins/mod_jibri_session.lua:1-127`).
5. **Jibri → Jicofo.** Jibri answers `PENDING` (`XmppApi.kt:329-415`), joins the room, then sends status `ON` (and later `OFF`) back to Jicofo (`XmppApi.kt:418-458`). In the room it adds `session_id` and `mode=file` to its presence (`jibri@e05e116:src/main/kotlin/org/jitsi/jibri/service/impl/FileRecordingJibriService.kt:199-206`; `selenium/pageobjects/AppCallPage.kt:656-676`).
6. **Jicofo → everyone.** Jicofo publishes `jibri-recording-status` with `status`, `session_id` and `initiator` (or `terminator` on OFF) in its own presence (`JibriRecorder.kt:165-201`). Every client then shows the label, and observers who also saw the metadata flip get the sound, the "started by" notification and, if configured, the consent dialog.

**What the custom bot service has to do:**

- **Brewery side:** keep a control connection in the brewery and publish idle or busy.
- **Start:** on START, reply `PENDING`, start recording in the room (the bot may already be in the room), add the presence elements, then send `ON`.
- **Stop:** on STOP, finish the files and send `OFF`.

**The trigger problem.** The start IQ and the `recording.isRecordingRequested` metadata write must both come from a **moderator occupant**. Metadata writes are moderator-only by default (`resources/prosody-plugins/mod_room_metadata_component.lua:16-21,333-353`). Three ways to meet that:

- **(a) Staff start it manually** with the existing "Start recording" dialog. This does not meet "record from creation".
- **(b) Make the bot's in-room session a moderator** and have it send both. Ways to do that:
  - a small Prosody module that gives owner affiliation to the recorder JID;
  - the `jitsi-metadata-allow-moderation` hook, which lets a module allow specific writers (`mod_room_metadata_component.lua:16-21`).

  A bot that is classified as Jibri is never auto-elected moderator (§2.1.4), so this needs explicit server code.
- **(c) A server-side Prosody module** sets `room.jitsiMetadata.recording` and sends the IQ. I have not verified this; Jicofo's `iq.from` check (`BaseJibri.kt:150-158`) means the IQ must appear to come from an occupant JID.

When the bot itself is the initiator, the "X started recording" text names a hidden participant. I did not check what name the client shows (Unverified).

#### 2.3.3 Path N2: presence-only label (no Jicofo involvement)

- **Mechanism.** If the hidden bot adds `<session_id>…</session_id>` and `<mode>file</mode>` to its MUC presence, every LJM client creates a FILE session with status `on` (`RecordingManager.ts:300-323`; `recordingXMLUtils.ts:50-60`). That makes `isRecordingRunning` true, so the **label shows**.
- **What is missing.** No initiator arrives, so there is **no start sound, no "started by" notification and no consent dialog** (§2.3.1).
- **When the bot leaves,** LJM marks the session off (`RecordingManager.ts:104-119`).
- **Status:** from code reading only, not run (Unverified).

#### 2.3.4 Path N3: `localRecording` participant property (toast + sound, no label)

- **Sender side.** A participant that sets the `localRecording` property makes every other client run `_localRecordingUpdated` (`react/features/base/participants/middleware.ts:485-548`, handler at 792-818). That shows `notify.localRecordingStarted` ("{{name}} has started a local recording.", with name fallback "Somebody", `lang/main.json:949-950,998`) and plays `RECORDING_ON_SOUND_ID`. jitsi-meet itself only sends the property when `localRecording.notifyAllParticipants` is set (`react/features/base/participants/middleware.ts:258-278`; `config.js:523-533`).
- **Receiving side for a hidden bot.** The handler does not check whether the participant is in Redux, so the toast and sound fire for a hidden bot too. The label check (`isRemoteParticipantRecordingLocally`, `react/features/recording/functions.ts:382-393`) walks Redux remote participants. `PARTICIPANT_UPDATED` ignores unknown remote ids (`react/features/base/participants/reducer.ts:206-228`). So **no lasting label** appears.
- **Problem with the wording.** It says "local recording", which is wrong for a server recording.

#### 2.3.5 Path N4: static and out-of-band disclosure

- `recordings.showPrejoinWarning` shows a fixed pre-join warning to everyone, whether or not anything is recording (`config.js:471-490`; `Prejoin.tsx:510,524`).
- Consent captured by the hospital system before the link is issued is outside Jitsi.
- Either one can complement N1–N3, but neither shows that recording is actually running.

#### 2.3.6 Minimal fork change for a label

If N1 is too much work, these fork changes can show disclosure based on the bot:

- **Option 1: change nothing in the client.** Combine N2 (presence `session_id` + `mode`) with the existing label. The label already works.
- **Option 2: add the missing parts on top of N2.**
  - The sound: in the `RECORDING_SESSION_UPDATED` handler, play `RECORDING_ON_SOUND_ID` when a FILE session goes ON without an initiator (`react/features/recording/middleware.ts:493-583`).
  - Consent: relax `shouldRequireRecordingConsent` so it does not require an initiator (`react/features/recording/functions.ts:488-536`).

  Both changes touch logic that upstream deliberately ties to Jicofo's initiator. Expect merge conflicts when you sync with upstream.
- **Option 3: make `_localRecordingUpdated` say "recording" instead of "local recording" for hidden-domain senders** (`react/features/base/participants/middleware.ts:792-818`). This is weaker, because there is still no label.

### 2.4 Joining when the room is created

#### 2.4.1 How rooms are created

- **Who creates rooms.** The conference MUC has `restrict_room_creation = true` (`doc/debian/jitsi-meet-prosody/prosody.cfg.lua-jvb.example:85`) and Jicofo (`focusUser`) is its admin (line 95).
- **How it happens.** A client sends a conference request to focus. Jicofo creates and joins the MUC, and then the client joins. jitsi-meet adds `room=<name>` to the BOSH/WebSocket and conference-request URLs (`react/features/base/connection/actions.any.ts:148-154`).
- **What it means for the bot.** The bot's own join creates the room. The bot does not have to wait for the patient.
- I could not reach Prosody's own docs for the exact `restrict_room_creation` semantics (Unverified).

#### 2.4.2 Existing hooks and plugins

- **No event-sync or webhook module** is in this repo's `resources/prosody-plugins/`. Modules that hook `muc-room-created` include:
  - `mod_muc_meeting_id.lua:55`;
  - `mod_polls_component.lua:476`;
  - `mod_room_metadata_component.lua:388`;
  - `mod_speakerstats_component.lua:342`;
  - `mod_reservations.lua:688`;
  - `mod_muc_allowners.lua:29`.

  Any of them shows the hook pattern a custom module would use. The handbook's sample `mod_force_async_transcription` hooks `muc-room-created` the same way (`handbook@a337568:docs/devops-guide/transcription.md:186-200`).
- **`mod_reservations`** sends `HTTP POST <api>/conference` with `name`, `start_time` and `mail_owner` "when the first user joins a MUC room", before creation, and DELETE when the room is destroyed (`resources/prosody-plugins/mod_reservations.lua:1-60,374-383,680-690`; https://jitsi.github.io/handbook/docs/devops-guide/reservation, `handbook@a337568:docs/devops-guide/reservation.md:85-96`). It can serve as a creation webhook, but it also enforces whatever the API answers (duration, lobby, password, `max_occupants`). The hospital API would have to implement the reservation contract.
- **`mod_muc_census`** serves an unauthenticated `GET /room-census` that lists rooms with `participants` (focus excluded) and `created_time`. It is for polling only and must not be public (`resources/prosody-plugins/mod_muc_census.lua:1-114`).
- **`mod_room_destroy`** listens for a `maybe-destroy-room` event (`resources/prosody-plugins/mod_room_destroy.lua:1-15`).
- **`mod_test_observer`** tracks pre-create, created, joined, left and destroyed events, but says "Test-only module. Never load in production" (`resources/prosody-plugins/mod_test_observer.lua:1-80`).

#### 2.4.3 Options compared

| Trigger | How | Pros | Cons |
|---|---|---|---|
| **Hospital system calls the bot** | When it issues the patient's link (or the JWT), the system tells the bot service "join room X". The bot's join creates the room | No Prosody code; the bot is in the room before the patient | Rooms created by any other path are missed; needs retry/health logic |
| Custom Prosody module on `muc-room-created` | A ~50-line module POSTs to the bot service | Catches every room creation | Custom Lua to maintain; the room is created by the patient's join, so the first seconds are missed |
| `mod_reservations` | Reuse the POST-before-create callback | Stock module; fires before creation | You must implement the reservation API contract; it also enforces policy |
| `mod_muc_census` polling | Poll `/room-census` | Stock | Polling delay; unauthenticated endpoint |

#### 2.4.4 Evidence timeline

Sources the bot can record, each with a wall-clock timestamp:

- **Participant joins and leaves.** LJM `USER_JOINED` / `USER_LEFT` with the participant id, display name and **server-stamped identity**. `mod_presence_identity` removes any `identity` the client put in its presence and inserts the JWT `context.user` / group verified by Prosody (`resources/prosody-plugins/mod_presence_identity.lua:1-19`; `resources/prosody-plugins/util.lib.lua:237-280`). The bot can attribute each track to a JWT `sub`/user id rather than a self-chosen name. This requires the module to be loaded on the main VirtualHost.
- **Track events.** `TRACK_ADDED`, removal and mute changes, plus the owner of each track, mapped to the file being written (`LoadTestClient.ts:406-431`; `lib-jitsi-meet@de80eae:modules/RTC/TraceablePeerConnection.ts:1515-1535,1885-1916`; `modules/xmpp/SignalingLayerImpl.ts:204-211`).
- **The conference `meetingId`** from `mod_muc_meeting_id`, which `mod_jibri_session.lua` also uses as `session_id`. It ties files to one room instance.
- **Server-side cross-check.** Jicofo logs each member join with room context (`JitsiMeetConferenceImpl.java:346,913-923`). A small Prosody module on `muc-occupant-joined` / `muc-occupant-left` could write an independent audit log. `mod_test_observer` shows the hooks, but it is test-only.

**When to start and stop recording** is a policy decision (§4):

- record the whole room lifetime, with staff joins and leaves as markers; or
- record only while at least one staff member is present.

Both are easy with per-track recording, because tracks only exist while their owner is present.

### 2.5 Auth and lobby

#### 2.5.1 JWT `token_verification`

- **Default behaviour.** `mod_token_verification` runs at priority 99 on `muc-room-pre-create` and `muc-occupant-pre-join` (`resources/prosody-plugins/mod_token_verification.lua:129-147`). In `verify_user` (66-127):
  - admins are exempt;
  - domains or bare JIDs in `token_verification_allowlist` are exempt (read at line 61). The comment at line 83 reads "allowlist for participants, jigasi (sip & transcriber), jibri (recorder & sip)";
  - everyone else goes through `token_util:verify_room`.
- **A tokenless session is rejected by default.** `verify_room` (`resources/prosody-plugins/token/util.lib.lua:488-600`) allows a session with no token only when `allow_empty_token` is on (line 118). Otherwise, with `enable_domain_verification` (default true, line 154) and `asap_require_room_claim` (default true, line 197), it returns `room-name-does-not-match`.
- **So the bot needs either** `token_verification_allowlist = { "recorder.<domain>" }`, **or** its own JWT whose `room` claim covers the room. Claims can be `*` or a Lua pattern when `token_regex_enabled`, which defaults to true (line 164; `lib-jitsi-meet@de80eae:doc/tokens.md:39-51,195-203`).
- **The Debian package does not set this up.** `jitsi-meet-tokens` switches the main host to token auth and enables `token_verification`, but sets no allowlist (`debian/jitsi-meet-tokens.postinst:55-70`).
- **Docker.** Its Prosody template does not set `token_verification_allowlist` either (grep of `docker-jitsi-meet@6bb51e6:prosody/`). How a Docker Jibri passes token verification with JWT enabled is Unverified.
- **The bot's own login is not affected.** It is on `recorder.<domain>` with `internal_hashed`, not on the token VirtualHost, so connect-time token checks do not apply to it.

#### 2.5.2 Lobby

- **Lobby on.** When the room is members-only, `muc_lobby_whitelist` on the main VirtualHost admits the bot's domain or JID as `member` (`resources/prosody-plugins/mod_muc_lobby_rooms.lua:111,583-617`).
- **`muc_wait_for_host` interaction (if used).**
  - That module holds non-host joiners in a persistent lobby until a "host" arrives. A host is a session with a verified JWT, or a PLAIN login on `muc_mapper_domain_base` (`resources/prosody-plugins/mod_muc_wait_for_host.lua:1-13,59-115`).
  - A bot on `recorder.<domain>` is neither, so a bot that joins first would cause a waiting lobby to be created.
  - Whether the lobby whitelist then lets the bot in depends on the order of the two pre-join hooks, which I did not verify.
  - If that module is used, test this case or give the bot a JWT.
- **Lobby knocks go to moderators.** If the bot is wrongly elected moderator (not trusted as Jibri, §2.1.4), and is the only moderator present, nobody can admit people from the lobby.

#### 2.5.3 Minimum configuration sketch

Built from the cited sources; not tested.

```lua
-- Main VirtualHost (token auth, lobby)
VirtualHost "<domain>"
    -- ...existing token config...
    muc_lobby_whitelist = { "recorder.<domain>" }

-- Conference MUC
Component "conference.<domain>" "muc"
    modules_enabled = { ...; "token_verification"; "muc_max_occupants"? }
    token_verification_allowlist = { "recorder.<domain>" }
    muc_access_whitelist = { "recorder.<domain>" }      -- only if muc_max_occupants is used
    -- recorder_prefixes = { "recbot@recorder.<domain>" } -- only if Jibri treatment in Jitsi modules is wanted

-- Hidden host for the bot
VirtualHost "recorder.<domain>"
    modules_enabled = { "smacks"; }
    authentication = "internal_hashed"
-- prosodyctl register recbot recorder.<domain> <password>
```

The other two pieces:

- Jicofo: `jicofo { xmpp { trusted-domains = [ "recorder.<domain>" ] } }`. With that, plus the bot advertising `http://jitsi.org/protocol/jibri`, the bot is `isJibri`.
- Web `config.js`: `hiddenDomain: 'recorder.<domain>'`.

### 2.6 Room names derived from HN

Facts only. Where the room name ends up:

| Place | Evidence |
|---|---|
| Page URL path, and the nginx access log | `location ~ ^/([^/?&:'"]+)$ { set $roomname "$1"; … }` (`doc/debian/jitsi-meet/jitsi-meet.example:198-201`). The log format redacts the **query string** only when it contains `jwt`/`token`; the path is kept (`jitsi-meet.example:39-53,95`) |
| BOSH / WebSocket / conference-request URLs (`?room=<name>`) | `react/features/base/connection/actions.any.ts:148-154`; proxied at `jitsi-meet.example:145-161,187-196`. Requests that also carry `token=` are redacted by the same rule (LJM appends `token=` to the service URL, `lib-jitsi-meet@de80eae:modules/xmpp/xmpp.ts:193,1427`) |
| MUC JID `<name>@conference.<domain>` in Prosody | e.g. `mod_token_verification.lua:100-103` logs the room on failure; `mod_muc_cleanup_backend_services.lua:69`; `mod_room_destroy.lua:9`; `mod_room_metadata_component.lua:366`; `/room-census` output |
| Jicofo logs | log context `room` (`jicofo@ef69ab6:jicofo/src/main/java/org/jitsi/jicofo/conference/JitsiMeetConferenceImpl.java:346`; `jicofo-common/.../ChatRoomImpl.kt:91`) |
| JVB logs | `conf_name` in the log context (`jitsi-videobridge@2bfa5b4:jvb/src/main/java/org/jitsi/videobridge/Conference.java:352-354,479-482`) |
| rtcstats | identity uses `conference.options.name` (`lib-jitsi-meet@de80eae:modules/RTCStats/RTCStats.ts:101,132,180,193`); config at `config.js:1290-1307` |
| JWT `room` claim | must match the room name (or `*` / a pattern) (`token/util.lib.lua:488-600`; `lib-jitsi-meet@de80eae:doc/tokens.md:39-51`) |
| Reservation API | `name` is sent to the external API (`handbook@a337568:docs/devops-guide/reservation.md:91-92`) |

Existing mechanisms that look like aliasing:

- **`brandingRoomAlias`** is used only in `getInviteURL` when dynamic branding's `inviteDomain` is set (`config.js:1883-1888`; `react/features/base/connection/functions.ts:59-66`). It changes invite links, **not** the MUC room name or the URL path the user opens.
- **Analytics `obfuscateRoomName`.**
  - `config.js:1286-1288` documents it as `analytics.obfuscateRoomName`;
  - the code reads `state['features/base/config'].analysis?.obfuscateRoomName` (`react/features/base/conference/functions.ts:453-461`; type at `react/features/base/config/reducer.ts:62-64`);
  - the obfuscated name feeds only `analytics.setConferenceName` (`react/features/analytics/functions.ts:270`), not rtcstats or server logs.

  The key name in the docs (`analytics`) does not match the code (`analysis`).
- **JWT room claims** accept `*` and Lua patterns. This changes what a token authorises, not what the room is called.

---

## 3. Options comparison

Effort is my estimate, not sourced.

| Approach | Dependencies | Hidden? | Per-track or composite | Notification path | Effort | Risks |
|---|---|---|---|---|---|---|
| **A. Headless Chromium + LJM + `MediaRecorder` per track** (recommended) | Chromium, Puppeteer/Playwright, LJM bundle, control service; Prosody/Jicofo config §2.5.3 | Yes (`hiddenDomain`) | Per-track WebM (audio + video); composite in post | N1 (Jibri protocol) for full UI; N2 for label only | Medium (recording) + Medium (N1) | Headless media capture unverified; WebM integrity; clock sync across files; uplink load from high constraints; crash gaps |
| A + Jibri-protocol emulation (N1) | As A, plus a control account in the Jibri brewery and Jicofo `jibri.brewery-jid` | Yes | Per-track | Label, sound, "started by", consent | Medium–High | Trigger needs a moderator occupant (custom Prosody code or manual start); protocol drift across Jicofo versions |
| **B. JVB export + `jitsi-multitrack-recorder`** | JVB, Jicofo `transcription.url-template`, a Prosody module that sets `asyncTranscription` + `recording.isTranscribingEnabled`, the recorder service | No participant at all | Per-speaker **audio only** (MKA) | Transcribing label ("being transcribed") | Low–Medium | **No video**; wording says transcription; the pairing is not documented upstream |
| C. Jigasi transcriber `RECORD_AUDIO` | Jigasi, hidden-domain login | Yes | Mixed audio WAV | Transcriber presence / transcribing UI | Medium | Audio only; Jigasi transcription is deprecated |
| D. Non-browser WebRTC client | XMPP + Jingle + Colibri implementation, RTP handling | Yes (same config) | Per-track (raw RTP/containers) | Same as A | High | Re-implements LJM; no upstream reference |
| E. Jibri (for reference) | Chrome, Xorg/Xvfb, ffmpeg, ALSA loopback (older releases), Jibri + brewery | Yes | Composite MP4 of the page | Native (Jicofo) | Already tried and rejected | One recording per instance; composite only |

---

## 4. Open decisions for the owner

1. **P2P:** turn it off deployment-wide (deterministic, everything goes through JVB), or keep it and accept that media bypasses the bot whenever the bot is absent (§2.2.6)?
2. **Recording scope:** the whole room lifetime with staff-visit markers, or only while staff are present (§2.4.4)?
3. **Disclosure path:**
   - N1, Jibri-protocol emulation: full existing UI, most work;
   - N2, presence-only label;
   - N2 plus a small fork change for sound and consent;
   - in every case, whether to add `showPrejoinWarning` and consent in the hospital system (§2.3).
4. **Who triggers "start":** the hospital system (bot starts on room creation), a staff moderator, or a server-side Prosody module. N1 needs a moderator occupant (§2.3.2).
5. **Room-creation trigger:** the hospital system calls the bot, or a custom Prosody `muc-room-created` hook, or `mod_reservations` (§2.4.3).
6. **Bot classification:** add `recorder.<domain>` to Jicofo `trusted-domains` and advertise the Jibri feature (recommended, prevents moderator election), and decide whether the bot JID should match `recorder_prefixes`. That match triggers `mod_muc_cleanup_backend_services`, which destroys a room left with only the bot (§2.1.3).
7. **Room naming:** keep the HN or use an opaque id mapped by the hospital system. Note what each place in §2.6 logs.
8. **Storage:** retention, encryption at rest and access control for recordings and timelines (PDPA, sensitive data). This is outside this research.
9. **Fallback:** is an audio-only recording (option B) acceptable as a backup when the video bot fails?
10. **Video quality:** the target `maxHeight` for evidence (e.g. 360p vs 720p), weighed against the extra uplink load on patient devices (§2.2.1 item 5).

---

## 5. Unverified

- **Prosody core behaviour:** the exact semantics of `restrict_room_creation`, and how non-persistent rooms are destroyed when empty. prosody.im was unreachable from this environment (proxy 403).
- **Headless capture:** whether headless Chromium (no Xvfb, no audio device) plays and records remote WebRTC audio and video tracks with `MediaRecorder`, and how many rooms one instance can record. No primary source found.
- **WebM files:** whether WebM produced by `MediaRecorder` has seekable metadata and duration, and how to align several per-track files to one clock. Not checked.
- **Presence-only label (N2):** behaviour comes from reading code; it was not run.
- **Bot as initiator (N1):** what name the "started by" notification shows when the initiator is a hidden participant. Whether Jicofo checks anything about the "Jibri" after `ON`, for example that it actually joined.
- **`mod_muc_wait_for_host` and lobby whitelist:** the order of their pre-join hooks when the bot joins first.
- **Docker with JWT:** how a Docker Jibri passes `token_verification` with JWT enabled, given that no allowlist is set there.
- **E2EE:** I did not trace what a server-side LJM bot receives when participants enable E2EE. I expect undecryptable media, but did not verify it.
- **Multitrack recorder pairing:** whether `jitsi-multitrack-recorder` accepts the TRANSCRIBER-type connect that Jicofo creates through `transcription.url-template`. Jicofo's own example URL points at a `/recorder/` path, but no document confirms the pairing.
- **Jibri audio:** how Jibri captures audio after release 7439, when the ALSA loopback stopped being required.
- **Third-party plugins:** any `jitsi-contrib` Prosody event-sync or webhook plugins. Not reviewed; they are third-party.
- **`obfuscateRoomName`:** whether runtime behaviour uses `analytics` or `analysis`. Only the code was read.
- **SSRC rewriting per endpoint:** whether Jicofo enables SSRC rewriting per endpoint based on the advertised feature. I read the LJM advertisement side only.
- **Handbook URLs:** the published URLs below follow `docusaurus.config.js` and front-matter ids. They were not fetched.

---

## 6. Sources

### This repo (HEAD `ef42f1d`)

- `config.js` (471-490, 523-533, 1286-1307, 1883-1901)
- `conference.js` (205-213, 813-816, 1391-1434)
- `doc/debian/jitsi-meet-prosody/prosody.cfg.lua-jvb.example`
- `doc/debian/jitsi-meet/jitsi-meet.example`
- `debian/jitsi-meet-tokens.postinst`
- `lang/main.json` (949-950, 998, 1180, 1673)
- `webpack.config.js` (404-413)
- `tests/malleus/README.md`
- `react/features/load-test/loadTestParticipant.ts`, `react/features/load-test/LoadTestClient.ts`
- `react/features/base/conference/functions.ts`, `middleware.any.ts`
- `react/features/base/config/configType.ts`, `reducer.ts`
- `react/features/base/connection/actions.any.ts`, `actions.web.ts`, `middleware.web.ts`, `functions.ts`
- `react/features/base/participants/middleware.ts`, `reducer.ts`
- `react/features/recording/middleware.ts`, `functions.ts`, `actions.any.ts`, `constants.ts`, `components/AbstractRecordingLabel.ts`, `components/web/TranscribingLabel.tsx`, `components/Recording/AbstractStartRecordingDialog.ts`, `components/Recording/LocalRecordingManager.web.ts`
- `react/features/transcribing/reducer.ts`, `functions.ts`
- `react/features/subtitles/middleware.ts`, `actions.any.ts`
- `react/features/prejoin/components/web/Prejoin.tsx`; `react/features/base/premeeting/components/web/PreMeetingScreen.tsx`
- `react/features/analytics/functions.ts`
- `resources/prosody-plugins/`:
  - `util.lib.lua`, `token/util.lib.lua`
  - `mod_token_verification.lua`, `mod_muc_lobby_rooms.lua`, `mod_muc_wait_for_host.lua`, `mod_muc_max_occupants.lua`
  - `mod_muc_cleanup_backend_services.lua`, `mod_presence_identity.lua`, `mod_room_metadata_component.lua`
  - `mod_filter_iq_jibri.lua`, `mod_jibri_session.lua`
  - `mod_muc_census.lua`, `mod_room_destroy.lua`, `mod_test_observer.lua`, `mod_reservations.lua`

### Upstream (shallow clones, read-only)

- **lib-jitsi-meet@de80eae:**
  - `JitsiConference.ts`, `JitsiParticipant.ts`, `JitsiConnection.ts`
  - `modules/xmpp/ChatRoom.ts`, `modules/xmpp/Caps.ts`, `modules/xmpp/xmpp.ts`, `modules/xmpp/SignalingLayerImpl.ts`
  - `modules/recording/RecordingManager.ts`, `recordingXMLUtils.ts`, `JibriSession.ts`
  - `modules/RTC/JitsiRemoteTrack.ts`, `modules/RTC/TraceablePeerConnection.ts`
  - `modules/flags/FeatureFlags.ts`, `modules/RTCStats/RTCStats.ts`
  - `doc/tokens.md`
- **jicofo@ef69ab6:**
  - `jicofo/src/main/resources/reference.conf`, `jicofo-common/src/main/resources/reference.conf`, `jicofo-selector/src/main/resources/reference.conf`
  - `JitsiMeetConferenceImpl.java`, `ChatRoomImpl.kt`, `ChatRoomMemberImpl.kt`, `ChatRoomRoleManager.kt`, `ClientRequirementsHandler.kt`
  - `jibri/JibriDetector.kt`, `jibri/JibriSession.java`, `jibri/JibriRecorder.kt`, `jibri/BaseJibri.kt`, `xmpp/JibriIqHandler.kt`
  - `bridge/colibri/ColibriV2SessionManager.kt`
- **jitsi-videobridge@2bfa5b4:** `jvb/src/main/resources/reference.conf`, `doc/allocation.md`, `doc/constraints.md`, `doc/rest-colibri2.md`, `export/ExporterWrapper.kt`, `export/Exporter.kt`, `Conference.java`
- **jitsi-xmpp-extensions@dd02a91:** `colibri2/Connect.kt`, `jitsimeet/ConferenceProperties.java`
- **jibri@e05e116:** `README.md`, `doc/xmpp_api.md`, `src/main/resources/reference.conf`, `selenium/JibriSelenium.kt`, `selenium/pageobjects/AppCallPage.kt`, `api/xmpp/XmppApi.kt`, `service/impl/FileRecordingJibriService.kt`
- **jitsi-multitrack-recorder@b489119:** `README.md`, `src/main/kotlin/org/jitsi/recorder/Main.kt`, `Config.kt`, `src/main/resources/reference.conf`
- **jigasi@3a2789a:** `jigasi-home/sip-communicator.properties`, `transcription/AbstractTranscriptPublisher.java`, `JvbConference.java`
- **docker-jitsi-meet@6bb51e6:** `prosody/rootfs/defaults/conf.d/jitsi-meet.cfg.lua`, `jicofo/rootfs/defaults/jicofo.conf`, `web/rootfs/defaults/settings-config.js`

### Handbook (handbook@a337568)

- Docker: https://jitsi.github.io/handbook/docs/devops-guide/devops-guide-docker (`docs/devops-guide/docker.md`)
- Token authentication: https://jitsi.github.io/handbook/docs/devops-guide/token-authentication (`docs/devops-guide/token-authentication.md`)
- Transcription (bridge-based): https://jitsi.github.io/handbook/docs/devops-guide/transcription (`docs/devops-guide/transcription.md`)
- Reservation system: https://jitsi.github.io/handbook/docs/devops-guide/reservation (`docs/devops-guide/reservation.md`)
