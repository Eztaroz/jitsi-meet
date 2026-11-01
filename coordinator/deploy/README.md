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
| `COORDINATOR_ROOMS_FILE` | A JSON file naming the stations and lounges: `{"stations": [{"room": "intake-1", "stage": "intake"}], "lounges": [{"room": "lounge-1"}]}`. A station's stage is `intake` or `aftercare`. A room in neither list is a patient's own. There is no editing in the service itself: change the file and restart. |
| `COORDINATOR_TIME_ZONE` | An IANA time zone, such as `Asia/Bangkok`. Default `UTC`. At every midnight in it, the encounters still open are closed as unfinished. |
| `COORDINATOR_AUDIT_KEY` | The key of the references to patients' rooms in the audit log. Defaults to the API secret. Whoever has it can tell which entries are of one room; keep it away from the people who read the log. |
| `COORDINATOR_RETENTION_DAYS` | How long encounters and audit entries are kept: `90` by default, as for evidence recordings. Older ones are deleted. |
| `COORDINATOR_RETENTION_SWEEP_SECONDS` | How often the service deletes them: `3600` by default; it also does at start-up. |
| `COORDINATOR_ISSUER_KEYS` | Turns the coordinator screen on: where the hospital issuer's public keys are, a directory or the URL of a key server, as `<source>/<SHA-256 of the key id>.pem`, the layout of the key server your participants' tokens use. Without it there is no screen. |
| `COORDINATOR_ACCEPTED_ISSUERS`, `COORDINATOR_ACCEPTED_AUDIENCES` | Which `iss` and `aud` a coordinator's token may have, comma-separated. Defaults `chat` and `jitsi`, as docker-jitsi-meet's. |
| `COORDINATOR_COORDINATOR_MARKER` | The claim that marks a coordinator, written like the role markers. Default `user.hospital_role=coordinator`. |
| `COORDINATOR_PREPARE_WAIT_SECONDS` | How long the recorder bot has to open a closed destination before a move into it fails with `recorder_bot_not_ready` and the participant stays where they are. Default `30`. Shorten it only to test; it must leave the recorder bot time to join a room. |
| `COORDINATOR_API_PORT` | The port the API listens on. Default 8091. |
| `COORDINATOR_DATA_DIR` | Where the database is. Default `/var/lib/coordinator`; mount a volume there. |

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

Staff join a station or a lounge with a fixed link (`<web URL>/<room name>`) and a staff token that names every room (`room: "*"`). A patient's own token names only their own room, so that a patient cannot open another's by typing it: the move brings the token that opens the destination.

A move sends the participant to another room with a token the service signs: it names the destination room only, carries the participant's own verified identity and role claim, and lasts five minutes (ADR 0009). Prosody must therefore accept it as a participant token:

- add the issuer (`coordinator`) to the accepted issuers (`JWT_ACCEPTED_ISSUERS` on docker-jitsi-meet), and the audience if you changed it;
- serve the service's public key from the key server of your participants' tokens (`JWT_ASAP_KEYSERVER`), at `<URL>/<sha256 of the key id>.pem`. A key server has one set of accepted issuers, so anyone who can write to it can add keys that sign tokens for any room: protect it.

Mind the room claim: it is the room name as Prosody names it, lower-case and URL-encoded.

## The coordinator screen

`https://<deployment>/coordinator/screen` is the coordinator's screen, in Thai, when `COORDINATOR_ISSUER_KEYS` is set. A coordinator signs in with a token from the hospital's issuer, the same issuer as the participants', that carries the coordinator role marker (`COORDINATOR_COORDINATOR_MARKER`) and a verified `id`. The screen is a form to sign in until then; the data behind it, `GET /screen/api/state`, answers only to such a token: the shared bearer secret does not open it (`403`), and neither does a call without a token (`401`). A single sign-on can send the coordinator to `/coordinator/screen#jwt=<token>`; the fragment never reaches a server.

Signed in, the coordinator sees:

- the queue of each stage, the longest-waiting first, with the time each patient has waited and the next patient suggested;
- every open room with who is in it, by the name in their token (a patient's room is named by the HN), labelled as a patient's room, a station with its stage, or a lounge; the configured rooms nobody is in are listed as closed; a patient's room that has no open encounter is marked.

From the screen the coordinator can also act. Every action goes through the same routes as the hospital's system, under `/screen/api/` (`POST /moves`, `POST /encounters`, `POST /encounters/<id>/stage`, with the coordinator's token), and the audit log names the coordinator's verified id as the issuer, not `system`:

- start an encounter for a patient's room that has none (the button in the room, marked "ยังไม่มี encounter");
- move any participant who can be moved, by choosing the destination room beside their name;
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
   muc_require_move_support_exempt_hosts = { "auth.meet.example.org", "recorder.meet.example.org" }
   ```

   List the auth domain (Jicofo, which also covers Jibri) and the recorder bot's hidden domain (`XMPP_HIDDEN_DOMAIN`), written out in full. Without the option the module assumes `auth.<domain>` and `recorder.<domain>`. Every other host must announce move support, the guest domain included. No dial-in is deployed: **adding dial-in (Jigasi) later means adding its host to this list**, otherwise it is refused.

The mobile apps' code stays in the repository; only the deployment refuses them.

### Checking a phone's browser by hand

Nothing in the automated suite runs on a phone's browser. Before relying on a deployment, run the [mobile-browser checklist](mobile-browser-checklist.md) on real devices: iOS Safari (current and previous iOS) and Chrome on Android. It has not been run yet.

## API

Every request carries `Authorization: Bearer <COORDINATOR_API_SECRET>`.

| Request | Answer |
|---|---|
| `POST /encounters` with `{"hn": "..."}` | `201` and the encounter `{id, stage, startedAt}`, with stage `waiting`, after the recorder bot accepted the patient's room. If the HN already has an open encounter: `200` and that encounter, and the recorder bot is asked nothing. `503` if the recorder bot is at capacity or unreachable; nothing is saved then, so the call can be repeated. |
| `GET /encounters/<id>` | The encounter: `hn`, `stage`, `stageStartedAt`, `startedAt`, the stage `history` (every stage it entered, and when), and `unfinished: true` if it was closed at midnight and not marked done. `404` if there is none. |
| `POST /encounters/<id>/stage` with `{"stage": "intake"}` | Puts the encounter in a stage: `waiting`, `intake`, `examination`, `aftercare` or `done`, forward, skipping, or back. `done` closes it. `200` and the encounter; `400` for an unknown stage; `404` for an unknown encounter; `409` if the encounter is done. Moving a participant never changes a stage. |
| `GET /queues` | `{queues: {waiting, intake, examination, aftercare}}`: each the open encounters in that stage, the longest-waiting first, each `{encounterId, hn, enteredAt, waitedSeconds, suggested}`. Only the first of a queue is `suggested`: the system suggests, it never moves anyone itself. |
| `GET /rooms` | `200` and `{rooms: [{name, kind, open, stage, occupants: [{endpointId, displayName, role, identity, supportsMove, cancelledMove}]}]}`: the open rooms, a patient's room named by the HN, and the configured stations and lounges that nobody is in, with `open: false`. `kind` is `patient`, `station` or `lounge`; a station has its `stage`. `role` is `patient` or `staff` by the role markers, `hidden` for the recorder bot and other hidden participants, else `unknown`; `identity` is the verified `{id, name}` when the deployment verifies identities. `503` if Prosody cannot be asked. |
| `POST /moves` with `{"from": {"room": "...", "endpointId": "..."}, "to": {"room": "..."}}` | Moves the participant `endpointId` from the open room `from.room` to the room `to.room`, both as `GET /rooms` names them. `202` and `{id, state}`: `counting_down` (the participant's page counts down five seconds, then enters the destination with a token for it), or `preparing` (the recorder bot is asked first, and the participant is sent once it is ready: for a patient moved to a patient's room that is closed, to record the room; for a patient moved into a station, to record that patient's time in it, under their HN, with the station named in the evidence recording). Or `200` and `{id, state: "refused", reason}`: `participant_not_found`, `participant_not_movable` (hidden, or unverified), `patient_into_lounge`, `not_the_patients_room` (a patient may be moved only into a station or into their own room, as the service has seen them in it, never into a room named after another HN, open or closed; while it has not seen a patient in their own room, only into a station), `destination_holds_a_patient` (a station), `patient_room_unknown` (a patient to be recorded in a station whose own room the service has not seen them in), `destination_not_open` (a staff member, or any move to a closed station), `already_being_moved` (the participant's earlier move is still under way). `503` if Prosody cannot be asked. |
| `GET /moves/<id>` | `{id, state, reason}`: `preparing`, `counting_down`, `done` (the same verified identity is in the destination), `cancelled` (the participant pressed "Stay here" during the countdown) or `failed`: `participant_did_not_arrive` (30 seconds after the countdown), `recorder_bot_at_capacity` (it answered `503`; nobody is moved), `recorder_bot_not_ready` (it was not waiting for the room within 30 seconds), `recorder_bot_unreachable` or `could_not_send_move`. |
| `GET /audit?limit=100` | `{entries}`: the newest audit entries (at most 1000), the newest first. Every move that has ended (`done`, `cancelled`, `refused`, `failed`, with its `reason`) and every stage change (`from`, `to`, `outcome`) has one: `at`, `issuer` (`system` for a call with the bearer secret), `participantId` (the moved participant's verified identity id), `source` and `destination`, `encounterId`. A station or a lounge is named; a patient's room is a keyed reference, `room:` and 16 hexadecimal digits, never the HN (ADR 0005). The service's logs hold no HN either. |
| `GET /health` | `200` and the number of open encounters. |

Encounters are identified by an opaque id. The HN appears only in the body that starts an encounter and in what `GET /encounters/<id>` returns, never in a path or in the service's logs (ADR 0005).

With token authentication (Jicofo authentication), the recorder bot cannot start a room itself: "ready" means it is waiting for the room, and it joins as soon as the patient has opened it. Without it, the bot is in the room before the patient arrives.

### Waits that must be ordered

The recorder bot waits for a station's patient for `RECORDER_BOT_PATIENT_WAIT_SECONDS` (ADR 0006). That wait must be longer than the countdown plus the arrival wait of this service, 5 + 30 = 35 seconds, so that this service gives up first and has the station consultation discarded. The bot's default of 60 seconds satisfies it. Never set it to 35 or less in production.

A patient moved into a station is recorded there as a consultation of their own (ADR 0006). If they cancel the move, do not arrive, or the move fails, the service stops that consultation and nothing is kept. Their own room keeps being recorded while anyone is still in it. The service finds a patient's HN from the patient's room it saw them in, and keeps where each patient's own room is in its database by verified identity id (no HN is added to what is stored beyond the room name), so it survives a restart: moves under way resume for the time left, and a patient can be moved into a station or back into their own room without being seen again first. The midnight close and the 90-day retention sweep forget what was learned: a patient whose room is forgotten must be seen in their own room again. A room that is seen again unchanged counts as fresh for the sweep.
