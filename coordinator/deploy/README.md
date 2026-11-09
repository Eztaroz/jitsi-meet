# Coordinator service: operator guide

The coordinator service owns encounters, stages and queues, and moves participants between rooms (`GLOSSARY.md`, ADR 0008). This guide covers what exists so far: starting an encounter, listing the open rooms with who is in them, moving a participant, patients included, to another room, the participant cancelling it, the stages and queues, the audit log, and the coordinator screen. The hospital's system calls the service instead of the recorder bot; the service asks the recorder bot to record the patient's room.

It is for the hospital's internal network only, and is reached through the web server's TLS (see "Reaching it"). **Never publish its port.**

## Settings

| Variable | Meaning |
|---|---|
| `COORDINATOR_API_SECRET` (required) | The bearer secret the hospital's system sends. Treat it like a password. |
| `COORDINATOR_RECORDER_BOT_URL` (required) | The recorder bot service's base URL. |
| `COORDINATOR_RECORDER_BOT_SECRET` (required) | The recorder bot service's `RECORDER_BOT_API_SECRET`. |
| `COORDINATOR_PROSODY_URL` (required) | Prosody's HTTP base URL, where the coordinator API module listens (below). |
| `COORDINATOR_SIGNING_KID` (required) | The service's key id. |
| `COORDINATOR_SIGNING_KEY_FILE` (required) | The PEM private key file. Prosody must have the public key (below). Keep it like the hospital issuer's key: whoever holds it can call Prosody's coordinator API. |
| `COORDINATOR_PATIENT_MARKER`, `COORDINATOR_STAFF_MARKER` | The token claims that mark a verified identity as a patient or as staff, written `user.<claim>=<value>` or `group=<value>`, like the recorder bot's. With none, every occupant's role is `unknown`. |
| `COORDINATOR_TOKEN_SUBJECT` (required) | The `sub` claim of the tokens the service issues for a move, as your participants' tokens have it (the XMPP domain). |
| `COORDINATOR_TOKEN_ISSUER`, `COORDINATOR_TOKEN_AUDIENCE` | The `iss` and `aud` of those tokens. Defaults `coordinator` and `jitsi`. Prosody must accept them (below). |
| `COORDINATOR_ROOMS_FILE` | A JSON file naming the center, its stations, each station's lounge and the pathways: `{"centers": [{"id": "center-1", "stations": [{"id": "intake", "stage": "intake", "lounge": "lounge-intake"}], "clinics": [{"id": "gyn", "pathway": "short"}], "pathway": "short", "pathways": [{"id": "short", "stages": [{"id": "waiting", "name": "..."}, {"id": "examination", "name": "..."}, {"id": "done", "name": "..."}]}]}]}`. There is one center for now. A station is a team of staff for one stage, any stage of the center's pathways but `waiting` and `done`, and its lounge is the room where its free staff wait (ADR 0011). Station ids and lounges are unique. A room that is no lounge is a patient's own. The service refuses to start with a file in the old format of station rooms, with top-level `stations` and `lounges`. See "Pathways" below for `pathways`, `pathway` and `clinics`, which are all optional. There is no editing in the service itself: change the file and restart. |
| `COORDINATOR_TIME_ZONE` | An IANA time zone, such as `Asia/Bangkok`. Default `UTC`. At every midnight in it, the encounters still open are closed as unfinished; the survey report gives its times in it. |
| `COORDINATOR_AUDIT_KEY` | The key of the references to patients' rooms in the audit log. Defaults to the API secret. Whoever has it can tell which entries are of one room; keep it away from the people who read the log. |
| `COORDINATOR_RETENTION_DAYS` | How long encounters, satisfaction surveys and audit entries are kept: `90` by default, as for evidence recordings. Older ones are deleted. |
| `COORDINATOR_RETENTION_SWEEP_SECONDS` | How often the service deletes them: `3600` by default; it also does at start-up. |
| `COORDINATOR_ISSUER_KEYS` | Turns the coordinator screen on, and with `COORDINATOR_PATIENT_MARKER` the satisfaction survey: where the hospital issuer's public keys are, a directory or the URL of a key server, as `<source>/<SHA-256 of the key id>.pem`, the layout of the key server your participants' tokens use. Without it there is neither. |
| `COORDINATOR_ACCEPTED_ISSUERS`, `COORDINATOR_ACCEPTED_AUDIENCES` | Which `iss` and `aud` a coordinator's, or a patient's survey, token may have, comma-separated. Defaults `chat` and `jitsi`, as docker-jitsi-meet's. |
| `COORDINATOR_COORDINATOR_MARKER` | The claim that marks a coordinator, written like the role markers. Default `user.hospital_role=coordinator`. |
| `COORDINATOR_VIDEO_PLAYER_URL`, `COORDINATOR_VIDEO_PLAYER_SECRET`, `COORDINATOR_VIDEO_BASE_URL`, `COORDINATOR_VIDEO_PLAYER_MARKER` | Turn the waiting videos on. The first two are the [video player service](../../video-player/deploy/README.md)'s base URL and its `VIDEO_PLAYER_API_SECRET`; set together with the base URL of the web server that hosts the video files (for example `https://meet.example/`), which each video's `file` in the rooms file is resolved against. The marker, written like the role markers, is the claim the service puts in the token the video player joins a room with (for example `user.hospital_role=video_player`); set the same in the recorder bot's `RECORDER_BOT_VIDEO_PLAYER_MARKER` and in the mod that guards the patient's room. Without the URL there are no videos. The rooms file lists them, see "Waiting videos" below. |
| `COORDINATOR_API_PORT` | The port the API listens on. Default 8091. |
| `COORDINATOR_DATA_DIR` | Where the database is. Default `/var/lib/coordinator`; mount a volume there. |

## Pathways

The stages an encounter goes through come from the configuration, not the code (ADR 0013). A pathway is an ordered list of stages `{"id", "name", "defaultVideo"?}`, each with a Thai `name` for the coordinator's screen. It must start with `waiting` and end with `done`, and its stage ids are unique. Only these have meaning in the code: `waiting` (where an encounter starts), `done` (which closes it) and `examination`. All other stages are just names.

- A center's `pathways` lists the pathways it offers, each with an `id`. A pathway with the id `default` replaces the built-in default one: waiting, registration, intake, examination, aftercare, billing, pharmacy, done.
- A center's `pathway` names the pathway its encounters follow; a clinic in the center's `clinics` (`{"id", "pathway"?}`) may name another. An encounter follows its clinic's pathway, else its center's, else `default`, and stores the id when it starts. Without `pathways`, `pathway` and `clinics`, every encounter follows the built-in default pathway.
- A stage change is checked against the encounter's own pathway.
- The service refuses to start, and says which stage holds how many open encounters, when the configuration removes a stage that still holds open encounters. Change the file back, or wait until those encounters are done. A stage that holds none can be removed. Past stages stay in an encounter's history, shown by their id.
- Encounters stored before pathways follow the default pathway after the upgrade.

## Waiting videos

The rooms file lists the deployment's waiting videos beside `centers`: `"videos": [{"id": "intro", "title": "...", "file": "videos/intro.mp4"}]`. `file` is a path under `COORDINATOR_VIDEO_BASE_URL`, hosted by the deployment's web server. A stage of a pathway names its default with `"defaultVideo": "intro"`. A coordinator plays the default of the patient's current stage into their own room from the screen ("เล่นวิดีโอ" on the patient's queue entry), and stops it from the same button. A video plays once. It stops when a coordinator stops it, when a staff member joins the room after it started (one already in the room at the start does not stop it by leaving), and at its end, which the service notices by polling the video player's `/health` once a second while a video plays. The video is not kept over a restart of the coordinator service: the video player still ends it by itself. Every play and stop, and each refusal, is in the audit log (`kind: video`, `action`, `video`, `reason`).

The video player joins the room as a visible participant with the video player marker, so the recorder bot records its tracks in the evidence recording, and labels it in a Review file.

## Reaching it

The service speaks plain HTTP and is reachable only on the deployment's internal network (ADR 0008). The web server proxies `/coordinator/` to it over its own TLS, stripping the prefix:

- a coordinator opens `https://<deployment>/coordinator/screen`;
- the hospital's system calls `https://<deployment>/coordinator/...`, for example `POST /coordinator/encounters`.

With docker-jitsi-meet, mount `coordinator/deploy/nginx/coordinator.conf` into the `web` container at `/config/nginx-custom/coordinator.conf`; it is included at server level. Change the service's name and port in it (`http://coordinator:8091`) to match your network. The screen uses relative URLs, so it works under the prefix.

**The service's port must never be published** (no `ports:` entry, no host network): nothing but the web server's proxy may reach it, or the hospital's calls, which carry HNs, cross the network unencrypted.

## Running it

```bash
docker build -t coordinator:local coordinator/
```

Run it with the settings above and a volume at `/var/lib/coordinator`. Without the volume, encounters are lost when the container is replaced.

## Prosody

The service reads the open rooms from a Prosody module, `resources/prosody-plugins/mod_coordinator_api.lua`. On docker-jitsi-meet:

1. Mount the file into the `prosody` container at `/prosody-plugins-custom/mod_coordinator_api.lua`, and add `coordinator_api` to `XMPP_MODULES` (comma-separated, with `presence_identity`, which the identities need).
2. Serve the service's public key where Prosody can fetch it: `<URL>/<sha256 of the key id>.pem` (for example `printf %s "$KID" | sha256sum`). Set `XMPP_CONFIGURATION` to `coordinator_api_key_server = "<URL>"`. This is not the key server of the participants' tokens: the module accepts only tokens issued by `coordinator` for the audience `coordinator`, and only keys from this one.
3. Make Prosody's HTTP port (5280) reachable by the coordinator service, and by nothing else. The module's endpoint lists everyone in every room.

`coordinator/test-deployment/docker-compose.yml` does all of this for the test deployment.

### Tokens for a move

Staff join their station's lounge with a fixed link (`<web URL>/<room name>`) and a staff token that names every room (`room: "*"`). A patient's own token names only their own room, so that a patient cannot open another's by typing it: the move brings the token that opens the destination.

A move sends the participant to another room with a token the service signs: it names the destination room only, carries the participant's own verified identity and role claim, and lasts five minutes (ADR 0009). Prosody must therefore accept it as a participant token:

- add the issuer (`coordinator`) to the accepted issuers (`JWT_ACCEPTED_ISSUERS` on docker-jitsi-meet), and the audience if you changed it;
- serve the service's public key from the key server of your participants' tokens (`JWT_ASAP_KEYSERVER`), at `<URL>/<sha256 of the key id>.pem`. A key server has one set of accepted issuers, so anyone who can write to it can add keys that sign tokens for any room: protect it.

Mind the room claim: it is the room name as Prosody names it, lower-case and URL-encoded.

## The coordinator screen

`https://<deployment>/coordinator/screen` is the coordinator's screen, in Thai, when `COORDINATOR_ISSUER_KEYS` is set. A coordinator signs in with a token from the hospital's issuer, the same issuer as the participants', that carries the coordinator role marker (`COORDINATOR_COORDINATOR_MARKER`) and a verified `id`. The screen is a form to sign in until then; the data behind it, `GET /screen/api/state`, answers only to such a token: the shared bearer secret does not open it (`403`), and neither does a call without a token (`401`). A single sign-on can send the coordinator to `/coordinator/screen#jwt=<token>`; the fragment never reaches a server.

Signed in, the coordinator sees:

- the queue of each stage, the longest-waiting first, with the time each patient has waited and the next patient suggested;
- every open room with who is in it, by the name in their token (a patient's room is named by the HN), labelled as a patient's room or as a lounge with its station's stage; the lounges nobody is in are listed as closed; a patient's room that has no open encounter is marked.

From the screen the coordinator can also act. Every action goes through the same routes as the hospital's system, under `/screen/api/` (`POST /moves`, `POST /encounters`, `POST /encounters/<id>/stage`, with the coordinator's token), and the audit log names the coordinator's verified id as the issuer, not `system`:

- start an encounter for a patient's room that has none (the button in the room, marked "ยังไม่มี encounter");
- move a staff member, by choosing the destination room beside their name: a patient's room or a lounge. Patients are never moved (ADR 0011);
- change an encounter's stage from its place in a queue, or mark it done ("เสร็จสิ้น").

A participant being moved shows as "กำลังย้าย" on every coordinator's screen, and what came of each move is listed in Thai with its reason: moved, cancelled by the participant, refused, or failed. A refusal is also shown at once where the coordinator asked.

It refreshes every two seconds. The coordinators' tokens cross the network over the web server's TLS only.

## Web only

The deployment supports the fork's web client only (ADR 0010, ADR 0007). On docker-jitsi-meet:

1. **Breakout rooms off:** set `ENABLE_BREAKOUT_ROOMS=false` on `web`, `prosody` and `jicofo`. The client then has no way to create a breakout room: the buttons are hidden because the server does not support them.
2. **Deep linking off:** set `DISABLE_DEEP_LINKING=true` on `web`, so that a phone opens the link in its browser and not in the mobile app.
3. **Everyone can be moved:** mount `resources/prosody-plugins/mod_muc_require_move_support.lua` into the `prosody` container at `/prosody-plugins-custom/` and set `XMPP_MUC_MODULES=muc_require_move_support`. Prosody then refuses to let a client join a room unless its first presence announces that it obeys moves (the local participant property `coordinatorMoveSupport`, which the fork's web client sets before it joins). The mobile apps and other clients do not, and are refused with "This client cannot be moved between rooms".

   Only the hosts in `muc_require_move_support_exempt_hosts` are exempt, set through `XMPP_MUC_CONFIGURATION` (add it to any `token_verification_allowlist` line you already have there):

   ```
   muc_require_move_support_exempt_hosts = { "auth.meet.example.org"; "recorder.meet.example.org" }
   ```

   Separate the hosts with `;`, not `,`: the docker-jitsi-meet image turns every comma in `XMPP_MUC_CONFIGURATION` into a new line, which breaks the list and stops Prosody from starting.

   List the auth domain (Jicofo, which also covers Jibri) and the recorder bot's hidden domain (`XMPP_HIDDEN_DOMAIN`), written out in full. Without the option the module assumes `auth.<domain>` and `recorder.<domain>`. Every other host must announce move support, the guest domain included. No dial-in is deployed: **adding dial-in (Jigasi) later means adding its host to this list**, otherwise it is refused.

The mobile apps' code stays in the repository; only the deployment refuses them.

### Leaving a room

With the welcome page and the close page both off (`ENABLE_WELCOME_PAGE=false`, `enableClosePage: false`), a participant who leaves a room, by hanging up or because staff ended the meeting for everyone, lands on `static/left.html`, in the meeting's language (the `leftPage` texts in `lang/`). After hanging up, it says that they have left and has a button that rejoins the room they left with the same token, which the meeting keeps in the tab's session storage. After staff ended the meeting for everyone, it says that the consultation has ended, with nothing to rejoin. A move does not go through it: the client navigates straight to the destination.

A patient is also asked the [satisfaction survey](#satisfaction-survey) there.

### Checking a phone's browser by hand

Nothing in the automated suite runs on a phone's browser. Before relying on a deployment, run the [mobile-browser checklist](mobile-browser-checklist.md) on real devices: iOS Safari (current and previous iOS) and Chrome on Android. It has not been run yet.

## Patients are never moderators

A patient is never a moderator, in their own room or anywhere else; staff are, so that they can end a consultation for everyone. Jicofo does not know who is a patient: with JWT authentication it makes everyone with a token a moderator, and a moderator can grant moderator to anyone from the filmstrip or the participants pane. Prosody refuses it instead. On docker-jitsi-meet, mount `resources/prosody-plugins/mod_muc_patient_never_moderator.lua` into the `prosody` container at `/prosody-plugins-custom/`, add it to `XMPP_MUC_MODULES` (`XMPP_MUC_MODULES=muc_require_move_support,muc_patient_never_moderator`), and set its marker in `XMPP_MUC_CONFIGURATION`, the same as `COORDINATOR_PATIENT_MARKER`:

```
muc_patient_marker = "user.hospital_role=patient"
```

Without the option the module does nothing and logs an error when Prosody starts. Prosody logs "Refusing the owner affiliation for a patient in <room>" each time it refuses; Jicofo logs a "Failed to grant ownership" warning once per patient who joins, which is expected.

## The video player's tile

A patient's client gives no menu on the video player's tile, so the patient cannot stop, mute or hide the video. The client finds the video player by its own config option, in the same form as `patientMarker`: `config.videoPlayerMarker = 'user.hospital_role=video_player'`, the same claim as `COORDINATOR_VIDEO_PLAYER_MARKER`.

## Satisfaction survey

A patient who has left a room is asked, on `static/left.html`, how the video call was: five faces to tap, then what stood out, an optional rating of four parts of the service (joining, picture and sound, waiting time, the staff's care) from 5 to 1, and suggestions. All of it is optional. The page sends the answers to `/coordinator/survey` with the patient's own token, which the meeting keeps in the tab's session storage, and the service keeps them with the patient's HN. It needs `COORDINATOR_ISSUER_KEYS` and `COORDINATOR_PATIENT_MARKER`: the token must be from the hospital's issuer and carry the patient marker. A staff member's page is not asked: the service answers its token `403`, and the page shows no survey.

The HN is the one of the patient's own room as the service has learned it (`hn_source` `known`). When it has not learned it, it is the room the page says the patient left, unless that is a lounge (`reported`): the patient's page can name any room, so a `reported` HN is the patient's word. The survey is tied to the HN's latest encounter, and to the stage it was in.

The hospital's quality department gets the report as CSV with `GET /surveys.csv` (below), opened in a spreadsheet: the times in `COORDINATOR_TIME_ZONE`, the tags as `picture`, `sound`, `wait` (waited too long), `disconnected`, `explained` (clear explanation) and `kind` (friendly staff), separated by `;`. The report names patients by HN: hand it on as patient data, under the hospital's PDPA rules. Each export is in the audit log, `kind: "survey_export"` with the `count` of surveys, and surveys older than `COORDINATOR_RETENTION_DAYS` are deleted, as encounters are.

| Request | Answer |
|---|---|
| `GET /survey` with `Authorization: Bearer <patient's token>` | `200` when the token may answer the survey; `403` and `{error}` when it is not a patient's (`not_a_patient`) or not valid; `401` without a token; `404` when the deployment has no survey. |
| `POST /survey` with the patient's token and `{"room": "...", "rating": 1-5, "tags": [...], "aspects": {"ease", "quality", "wait", "care": 1-5}, "comment": "..."}` | `201` and `{id}`. `400` for answers that are not a survey; `429` when the same patient sent one less than 30 seconds before. |

## API

Every request carries `Authorization: Bearer <COORDINATOR_API_SECRET>`.

| Request | Answer |
|---|---|
| `POST /encounters` with `{"hn": "...", "visitNumber": "...", "center": "...", "clinic": "..."}` | Only `hn` is required. `201` and the encounter `{id, stage, startedAt}`, with stage `waiting`, after the recorder bot accepted the patient's room. The encounter follows its clinic's pathway, else its center's, else the default one, and stores which. `visitNumber` is the hospital system's number for the visit; several encounters can share one. `400` for a `center` that is not configured or a `clinic` its center does not have. If the HN already has an open encounter: `200` and that encounter, and the recorder bot is asked nothing. `503` if the recorder bot is at capacity or unreachable; nothing is saved then, so the call can be repeated. |
| `GET /encounters/<id>` | The encounter: `hn`, `pathway`, `visitNumber`, `center`, `clinic`, `stage`, `stageName`, `stageStartedAt`, `startedAt`, the stage `history` (every stage it entered, and when, each with its `name`, which is the stage id once the configuration no longer has the stage), and `unfinished: true` if it was closed at midnight and not marked done. `404` if there is none. |
| `POST /encounters/<id>/stage` with `{"stage": "intake"}` | Puts the encounter in a stage of its pathway, forward, skipping, or back. `done` closes it. `200` and the encounter; `400` for a stage that is not in the encounter's pathway; `404` for an unknown encounter; `409` if the encounter is done. Moving a participant never changes a stage. |
| `POST /encounters/<id>/video` with `{"video": "intro"}` | Plays a waiting video once in the encounter's own room; `video` is optional, and the default of the encounter's current stage is played without it. `200` and `{video}`; `400` for a video that is not in the catalogue; `404` for an unknown encounter; `409` when a video is already playing, the stage has no default video, or the encounter is done; `503` when the video player cannot play now. |
| `POST /encounters/<id>/video/stop` | Stops the video playing in the encounter's room. `200`; `409` when none is playing. |
| `GET /queues` | `{queues: {<stage id>: [...]}}`: one queue for each stage of the configured pathways but `done` (with the default pathway: `waiting`, `registration`, `intake`, `examination`, `aftercare`, `billing`, `pharmacy`), each the open encounters in that stage, the longest-waiting first, each `{encounterId, hn, enteredAt, waitedSeconds, suggested}`. Only the first of a queue is `suggested`: the system suggests, it never moves anyone itself. |
| `GET /rooms` | `200` and `{rooms: [{name, kind, open, station, stage, occupants: [{endpointId, displayName, role, identity, station, supportsMove, cancelledMove}]}]}`: the open rooms, a patient's room named by the HN, and the lounges that nobody is in, with `open: false`. `kind` is `patient` or `lounge`; a lounge has its `station` and that station's `stage`. `role` is `patient` or `staff` by the role markers, `hidden` for the recorder bot and other hidden participants, else `unknown`; `identity` is the verified `{id, name}` when the deployment verifies identities. A staff member's `station` is the one whose lounge they are in, or, in a patient's room, the one whose lounge the service last saw them in (ADR 0011); none while it has never seen them in a lounge. `503` if Prosody cannot be asked. |
| `POST /moves` with `{"from": {"room": "...", "endpointId": "..."}, "to": {"room": "..."}}` | Moves the staff member `endpointId` from the open room `from.room` to the room `to.room`, both as `GET /rooms` names them: into a patient's room that is open, or into a lounge, open or not. Patients are never moved: every stage happens in their own room, and staff come to them (ADR 0011). `202` and `{id, state: "counting_down"}`: the staff member's page counts down five seconds, then enters the destination with a token for it. Or `200` and `{id, state: "refused", reason}`: `participant_not_found`, `patients_never_move` (the participant is a patient), `participant_not_movable` (hidden, or unverified), `destination_not_open` (a patient's room that is closed), `already_being_moved` (the participant's earlier move is still under way). `503` if Prosody cannot be asked. |
| `GET /moves/<id>` | `{id, state, reason}`: `counting_down`, `done` (the same verified identity is in the destination), `cancelled` (the participant pressed "Stay here" during the countdown) or `failed`: `participant_did_not_arrive` (30 seconds after the countdown), `could_not_send_move`, or `patient_moves_retired` (a move of a patient that was still waiting for the recorder bot when the service was updated to ADR 0011). |
| `GET /audit?limit=100` | `{entries}`: the newest audit entries (at most 1000), the newest first. Every move that has ended (`done`, `cancelled`, `refused`, `failed`, with its `reason`) and every stage change (`from`, `to`, `outcome`) has one: `at`, `issuer` (`system` for a call with the bearer secret), `participantId` (the moved participant's verified identity id), `source` and `destination`, `encounterId`. A lounge is named; a patient's room is a keyed reference, `room:` and 16 hexadecimal digits, never the HN (ADR 0005). The service's logs hold no HN either. |
| `GET /surveys.csv?from=...&to=...` | The [satisfaction survey](#satisfaction-survey) report of a period, as a CSV file with a byte order mark: `submitted_at`, `hn`, `hn_source`, `encounter_id`, `stage`, `room` (a lounge's name, or `own_room`), `rating`, `ease`, `quality`, `wait`, `care`, `tags`, `comment`. `from` and `to` are ISO 8601 times, such as `2030-01-01T00:00:00+07:00`; by default, the last 30 days. `400` for a time it cannot read. |
| `GET /health` | `200` and the number of open encounters. |

Encounters are identified by an opaque id. The HN appears only in the body that starts an encounter and in what `GET /encounters/<id>` returns, never in a path or in the service's logs (ADR 0005).

With token authentication (Jicofo authentication), the recorder bot cannot start a room itself: "ready" means it is waiting for the room, and it joins as soon as the patient has opened it. Without it, the bot is in the room before the patient arrives.

### What is kept over a restart

The service keeps where each patient's own room is, and each staff member's station, in its database by verified identity id (no HN is added to what is stored beyond the room name), so that they survive a restart; moves under way resume for the time left. The midnight close keeps them. Only the 90-day retention sweep forgets them, and a room or a station that is seen again unchanged counts as fresh for the sweep.

## Staff cannot end, kick or demote in a patient's room

No staff member can end a patient's own room or take the patient out of it, since either would end the consultation mid-encounter (ADR 0011, 0012). In a room with a patient in it, the client hides "end meeting for all" from everyone, and kick and demote-to-visitor for the patient, and Prosody refuses the same three, so that hiding the buttons is not the only guard. Mute and ask-to-unmute stay, and so does every moderator action in a room without a patient (a lounge). Nobody can unmute the patient: staff ask them to.

- Kick and demote-to-visitor are refused by `mod_muc_patient_never_moderator`, with the same `muc_patient_marker`. It now needs `patient_marker.lib.lua` beside it: mount `resources/prosody-plugins/patient_marker.lib.lua` into the `prosody` container at `/prosody-plugins-custom/` too. Kicks by the system (the coordinator service, Jicofo) are not refused.
- "End meeting for all" goes to the `end_conference` component, so `mod_end_conference` refuses it. Give it `patient_marker.lib.lua` the same way. It reads the marker from the MUC component's `muc_patient_marker`. Without a usable marker it logs a warning and any moderator can end any room, as upstream.
- The client hides the buttons by its own config option, in the same form as the marker for the token's `context.user` (`group=` markers do not work there): `config.patientMarker = 'user.hospital_role=patient';` in the web server's `config.js`.
