# Recorder bot: operator guide

The recorder bot records patient consultations as evidence. The hospital's room-creation system asks the recorder bot service to record a patient's consultation by HN; the service starts a headless Chromium for that consultation, and the bot joins the patient's room as a hidden participant. Nobody in the consultation sees the bot. The bot is never a moderator. It leaves when staff end the consultation for everyone, with the toolbar's End meeting for all.

This guide covers what the Jitsi deployment needs and how to run the service. The decisions behind it are in `docs/adr/` (0001 to 0005), and the words in `GLOSSARY.md`.

## What the deployment needs

| Piece | What |
|---|---|
| Web | This fork's web build, which carries the bot page `static/recorder-bot.html` and a room-name fix for HNs with `/` |
| nginx | `nginx/hn-rooms.conf`, for HNs with `/` |
| Prosody | A hidden recorder domain with the bot account, and the bot let through lobby, token checks and occupant limits |
| Jicofo | The recorder domain in `trusted-domains` |
| Client config | `hiddenDomain`, P2P disabled, 720p constraints |
| The service | The `recorder-bot` container, which reaches the Jitsi web server and the videobridge |
| Storage | The evidence storage root, and a persistent volume for the service's spool |

Below, `meet.example.org` stands for the deployment's domain and `recorder.meet.example.org` for the recorder domain. With docker-jitsi-meet, the environment variables named in each section set the same things.

### Web build

Serve this fork's web build (`make all`, or `make source-package`), not upstream's. The service loads `https://meet.example.org/static/recorder-bot.html`. That page uses the deployment's own `config.js` and `libs/lib-jitsi-meet.min.js`.

The fork also names the room in the XMPP websocket's `room` parameter exactly as the room's JID does. Upstream decodes it, so Prosody finds no room for a name with `/`, and "End meeting for all" does nothing in such a room.

### nginx: HNs with "/"

A patient's link is the deployment URL followed by the HN, URL-encoded: HN `12345/67` opens `https://meet.example.org/12345%2F67`. nginx decodes `%2F` before it picks a location, so a stock Jitsi nginx configuration reads that path as room `67` under tenant `12345`, and the patient would land in a different room from the bot.

Include `nginx/hn-rooms.conf` in the Jitsi `server` block, before its `location` blocks. With docker-jitsi-meet, put it in the web container's `/config/nginx-custom/`, which the image includes at that point:

```yaml
# docker-compose.yml, service "web"
volumes:
    - ./hn-rooms.conf:/config/nginx-custom/hn-rooms.conf:ro
```

The snippet serves a one-segment path that holds an encoded slash as a room without a tenant.

### Prosody

A VirtualHost for the recorder domain, with internal hashed authentication, and the bot account on it:

```lua
VirtualHost "recorder.meet.example.org"
    modules_enabled = { "smacks"; }
    authentication = "internal_hashed"
```

```sh
prosodyctl register recorder-bot recorder.meet.example.org '<bot password>'
```

On the main VirtualHost (`meet.example.org`), let the bot through the lobby:

```lua
muc_lobby_whitelist = { "recorder.meet.example.org" }
```

When JWT authentication is on, let the bot through token verification. This goes on the conference MUC component that loads `token_verification`:

```lua
token_verification_allowlist = { "recorder.meet.example.org" }
```

When the conference MUC component limits occupants with `muc_max_occupants`, keep the bot from counting against the limit or being refused:

```lua
muc_access_whitelist = { "focus@auth.meet.example.org", "recorder-bot@recorder.meet.example.org" }
```

docker-jitsi-meet: `ENABLE_RECORDING=1`, `XMPP_HIDDEN_DOMAIN=recorder.meet.example.org`, `JIBRI_RECORDER_USER=recorder-bot` and `JIBRI_RECORDER_PASSWORD=<bot password>` create the VirtualHost, register the account, and set `muc_lobby_whitelist` and, with `MAX_PARTICIPANTS`, `muc_access_whitelist`. When JWT is on, set `token_verification_allowlist` with `XMPP_MUC_CONFIGURATION=token_verification_allowlist = { "recorder.meet.example.org" }`; that variable is split at commas, so add other entries after a comma.

### Jicofo

```hocon
jicofo {
  xmpp {
    trusted-domains = [ "recorder.meet.example.org" ]
  }
}
```

The bot advertises the Jibri feature once connected. With its domain trusted, Jicofo treats it as Jibri and never makes it a moderator. docker-jitsi-meet sets this from `XMPP_HIDDEN_DOMAIN` when `ENABLE_RECORDING=1`.

### Client config

In the web `config.js`:

```js
config.hiddenDomain = 'recorder.meet.example.org';

// ADR 0002: media always goes through the videobridge, where the bot receives it.
config.p2p = { enabled: false };

config.resolution = 720;
config.constraints = {
    video: {
        height: { ideal: 720, max: 720, min: 180 },
        width: { ideal: 1280, max: 1280, min: 320 }
    }
};
```

docker-jitsi-meet: `ENABLE_RECORDING=1` with `XMPP_HIDDEN_DOMAIN` sets `hiddenDomain`; `ENABLE_P2P=false`; `RESOLUTION=720`.

### Recording label

While the bot is in the room, every participant sees jitsi-meet's in-call recording label (ADR 0004). The bot advertises a file recording session in its own presence, named after the consultation id, and sends its presence again about two seconds after each participant joins, so that a joiner who was not listening yet still gets it. This needs no Jibri and no client change. There is no consent prompt and no sound; collect any consent the hospital needs outside the call.

### Join links

The hospital's links must not override prejoin settings in the URL hash (for example `#config.prejoinConfig.enabled=false`). jitsi-meet then starts without media, and there is nothing to record. The prototype hit this. Set prejoin in the deployment's `config.js` instead.

### Verified identities

The bot can tell staff from the patient only when the deployment verifies who each participant is. Without that, every participant's role is `unknown` and the manifest lists no staff visits; everything else is recorded the same.

With JWT authentication, Prosody's `presence_identity` module copies each participant's token claims, `context.user` and `context.group`, into the participant's presence, and removes any identity the participant's client put there itself. The bot reads it, keeps the `id` and `name` claims, and gives the participant a role with two role markers:

| Setting | Example | Who it marks |
|---|---|---|
| `RECORDER_BOT_STAFF_MARKER` | `user.hospital_role=staff` | Staff: participants whose token has `"context": { "user": { "hospital_role": "staff" } }` |
| `RECORDER_BOT_PATIENT_MARKER` | `user.hospital_role=patient` | The patient |

A role marker is `user.<claim>=<value>`, for a claim in `context.user`, or `group=<value>`, for `context.group`. Values are compared as text, and the staff marker is checked first. A participant with neither is `unknown`, and so is one without an `id` claim. The hospital's token issuer sets the claim; use one of the hospital's own rather than one Jitsi reads, such as `moderator` or `affiliation`.

The service trusts presence identities only while a role marker is set, so set them only once `presence_identity` runs on every VirtualHost participants sign in to: on a VirtualHost without it, a client can claim any identity. Load it on the main VirtualHost, and on the guest VirtualHost if there is one:

```lua
VirtualHost "meet.example.org"
    modules_enabled = { "presence_identity"; }
```

With Jicofo authentication, only an authenticated participant starts a room, and the bot is not one. When the bot is asked to record a room nobody has started yet, it waits for someone who may and tries to join again every 5 seconds. Meanwhile its status is `waiting_for_participants`, the timeline starts with `waiting_for_host`, and the first-join wait counts from then.

docker-jitsi-meet: `ENABLE_AUTH=1` and `AUTH_TYPE=jwt` with the `JWT_*` settings, and `XMPP_MODULES=presence_identity`, which loads it on the main VirtualHost and, with `ENABLE_GUESTS=1`, on the guest one.

## The recorder bot service

### Image

Build the image from this fork:

```sh
docker build -t recorder-bot:<version> recorder-bot/
```

Behind a TLS-inspecting proxy, pass the proxy's CA certificate so that `npm ci` can reach the registry:

```sh
docker build --secret id=npm_ca,src=<proxy CA bundle> -t recorder-bot:<version> recorder-bot/
```

The image is based on Playwright's (Chromium and Node.js) and adds ffmpeg.

### Running it

`docker-compose.recorder-bot.yml` adds the service to a docker-jitsi-meet deployment. It reads the bot account and the public URL from that deployment's `.env`, and binds the control API to `127.0.0.1` unless `RECORDER_BOT_API_BIND` says otherwise.

It mounts the evidence storage root, `RECORDER_BOT_STORAGE_ROOT`, at the same path inside the container, and keeps the spool in the named volume `recorder-bot-spool`. The service runs as uid 1001, which must be able to write to the storage root. The mount propagates the host's mounts, so that the service sees the storage root's share once it is mounted, even when it is mounted, or mounted again, after the service started.

The service stores evidence recordings only in a storage root that holds the marker file `.recorder-bot-storage-root`, so that it never writes to the local disk under a mount point whose share is not mounted. Create the marker once, on the share itself, while it is mounted:

```bash
touch "$RECORDER_BOT_STORAGE_ROOT/.recorder-bot-storage-root"
```

When it is stopped, the service stops every consultation in progress, with stop reason `shutdown`, and finalises it. The compose file gives it a minute for that (`stop_grace_period`); a consultation it could not finalise in time stays in the spool, never finalised (see [When the storage root is unavailable](#when-the-storage-root-is-unavailable)).

The service's network must reach:

- the Jitsi web server at `RECORDER_BOT_JITSI_URL`, over HTTPS and its XMPP websocket;
- the videobridge's advertised address, on its media port (UDP 10000 by default).

Run one service per deployment. Each consultation runs in its own browser process, so a crash stays with one consultation.

### Capacity

The prototype measured, on a shared 4-vCPU host without GPU:

- about one CPU core per recorded 720p video track, since the bot re-encodes each one;
- about 0.4 GB of RAM per pair of participants recorded.

A consultation with a patient and one staff member records two video tracks, so it needs about two cores. Set `RECORDER_BOT_MAX_CONSULTATIONS` to about half the host's cores, leaving some headroom; the default of 2 suits a 4-core host. At the limit, the service refuses further consultations with `503` rather than record them badly. A consultation counts until it reaches a final status: while it finalises, it still remuxes its files.

Storage is at most about 680 MB per 30-minute consultation with two video participants (ADR 0003). The spool needs that much for each consultation in progress, and for each evidence recording it keeps while the storage root is unavailable (see [When the storage root is unavailable](#when-the-storage-root-is-unavailable)); the storage root needs it times the consultations per day times the retention period.

### Crashes

Each consultation's bot runs in its own browser, so a crash affects that consultation only. Its Chromium process carries `--recorder-bot-consultation=<consultation id>`, which Chromium ignores, so that an operator can tell which browser records which consultation.

When a bot's browser crashes, or the bot loses its connection, while the consultation runs, the service records `bot_interrupted` on the timeline and relaunches the bot into the same room about 2 seconds later. The relaunched bot records to new files in the same spool folder. Once it is back in the room, the service records `bot_resumed`, and the manifest lists the stretch in between as a gap. A participant the relaunched bot finds in the room stayed through the gap; one it does not find left during it, and is recorded as leaving when the bot resumed, because that is when the service learns it. The empty-room grace and the first-join wait then apply as usual: if everyone left during the gap, the grace runs from the resume.

The service relaunches a consultation's bot at most `RECORDER_BOT_MAX_RELAUNCHES` times. When it may not relaunch it again, the consultation stops with `stopReason` `bot_failed` and status `failed`, and what was recorded is still finalised and stored. A bot that goes away after its consultation has stopped is not relaunched.

### Settings

| Variable | Default | What |
|---|---|---|
| `RECORDER_BOT_API_SECRET` | required | The bearer secret every control API request must carry, `Authorization: Bearer <secret>` |
| `RECORDER_BOT_API_PORT` | `8090` | The control API's port |
| `RECORDER_BOT_JID` | required | The bot account, `recorder-bot@recorder.meet.example.org` |
| `RECORDER_BOT_PASSWORD` | required | The bot account's password |
| `RECORDER_BOT_JITSI_URL` | required | The Jitsi web server, `https://meet.example.org` |
| `RECORDER_BOT_STORAGE_ROOT` | required | The evidence storage root: the directory evidence recordings are moved to, for example the mount point of the hospital's file storage. The service never creates it |
| `RECORDER_BOT_SPOOL_DIR` | `/var/lib/recorder-bot/spool` in the image | Local storage where consultations are recorded and finalised. Keep it on a persistent volume with room for the consultations in progress |
| `RECORDER_BOT_RETENTION_DAYS` | `90` | How long evidence recordings are kept (ADR 0003). The service deletes older ones. See [Retention](#retention) |
| `RECORDER_BOT_RETENTION_SWEEP_SECONDS` | `3600` | How often the service looks for what is older than the retention period; at most a day |
| `RECORDER_BOT_STORE_RETRY_SECONDS` | `60` | How often the service retries moving the evidence recordings left in the spool into the storage root; at most a day. See [When the storage root is unavailable](#when-the-storage-root-is-unavailable) |
| `RECORDER_BOT_MAX_CONSULTATIONS` | `2` | How many consultations the service records at once. See [Capacity](#capacity) |
| `RECORDER_BOT_MAX_RELAUNCHES` | `3` | How many times a consultation's bot may be relaunched after a crash or a lost connection; `0` never relaunches it. See [Crashes](#crashes) |
| `RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS` | `60` | How long the bot stays once every human has left. A human who rejoins within it cancels the stop |
| `RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS` | `600` | How long the bot waits for the first human to join, counted from its own join, or from when it started waiting for someone to start the room |
| `RECORDER_BOT_PATIENT_WAIT_SECONDS` | `60` | In a station (below): how long the bot waits for the patient after it joined |
| `RECORDER_BOT_STAFF_MARKER` | none | Which verified identities are staff: `user.<claim>=<value>` or `group=<value>`. See [Verified identities](#verified-identities) |
| `RECORDER_BOT_PATIENT_MARKER` | none | Which verified identity is the patient, written the same way |
| `RECORDER_BOT_MAX_HEIGHT` | `720` | The highest video resolution the bot asks the videobridge for |
| `RECORDER_BOT_CHROMIUM_PATH` | Playwright's | A Chromium binary to run instead |
| `RECORDER_BOT_IGNORE_CERTIFICATE_ERRORS` | `false` | Accept any certificate from the web server. Only for test deployments |

### Control API

Every request needs the bearer secret; without it the service answers `401`.

| Request | Answer |
|---|---|
| `POST /consultations` with `{ "hn": "<HN>" }` | `201` and `{ "consultationId", "status" }` for a new consultation; `200` and the same for the consultation already running in that HN's room; `503` when the service is at its limit |
| `POST /consultations` with `{ "hn": "<HN>", "room": "<station>", "patient": "<verified identity id>" }` | The consultation of one patient in a station; see [Stations](#stations). Answers as above. The bot joins the station's room, and the evidence is kept under the HN. A request is matched on the HN and the station together, so a patient's own room and a station can be recorded at the same time |
| `POST /consultations/<consultationId>/stop` | Stops the consultation before its time, and answers `200` and the consultation once it has stopped. For a station whose patient never arrived, nothing is kept |
| `GET /consultations/<consultationId>` | `200` and the consultation: `status`, `startedAt`, `stoppedAt`, `stopReason`, `relaunches` (how many times its bot was relaunched), and once stored `evidenceLocation` |
| `GET /health` | `200` and `{ "status": "ok", "activeConsultations", "maxConsultations" }`, where `activeConsultations` counts the consultations that have not reached a final status, finalising ones included |

The room-creation system can repeat a `POST` safely, for example after a timeout: while a consultation runs in the HN's room, every `POST` for that HN returns it, and no second bot joins. Once it has stopped, the next `POST` starts a new consultation. A `503` means the consultation is not being recorded; the room-creation system must retry or alert someone, never carry on silently.

The consultation id is an opaque UUID. The service's logs name consultations by this id, never by HN. The room name is the HN normalised as jitsi-meet normalises a URL room name: NFKC, lower-case, URL-encoded, lower-case again.

A consultation's `status` goes:

1. `starting` while the bot launches and joins;
2. `waiting_for_participants` once the bot is in the room, or waits for someone to start it, until the first human joins;
3. `recording` from then on, including while the room is empty within the grace;
4. `finalising` once it has stopped, while the evidence recording is prepared;
5. a final status:
   - `stored`: the evidence recording is in the storage root, at `evidenceLocation`, which is relative to the storage root;
   - `spooled`: it could not be moved to the storage root, and stays in the spool; `error` says why. The service retries the move, and once it succeeds the status becomes `stored`, or `failed` when the bot had failed, with `evidenceLocation` (see [When the storage root is unavailable](#when-the-storage-root-is-unavailable));
   - `discarded`: a station consultation whose patient never arrived; nothing was kept;
   - `failed`: the bot could not be relaunched, or the finalisation failed; `error` says why. When the bot failed, what it recorded is still stored, at `evidenceLocation`.

`stopReason` says why it stopped:

| Stop reason | When |
|---|---|
| `room_destroyed` | Staff ended the consultation for everyone, with the toolbar's End meeting for all. The bot stops at once, without leaving first |
| `no_humans_for_grace` | Every human left, and nobody came back within `RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS` |
| `no_one_joined` | Nobody joined within `RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS` |
| `kicked` | A moderator removed the bot |
| `patient_left` | In a station: the patient left, though staff stay |
| `patient_did_not_arrive` | In a station: the patient did not arrive within `RECORDER_BOT_PATIENT_WAIT_SECONDS` |
| `stop_requested` | The hospital's system called `POST /consultations/<consultationId>/stop` |
| `shutdown` | The service was stopped |
| `bot_failed` | The bot crashed or lost its connection, and could not be relaunched. See [Crashes](#crashes) |

### Stations

A station is a fixed room that many patients pass through, one at a time (ADR 0006). Recording it as one long consultation would mix patients in one evidence recording kept under no one's HN, so each patient's time in it is a consultation of its own:

- it starts when the service is asked to (`room` and `patient` in the request), and the bot joins the station before the patient arrives;
- it stops as soon as that patient, recognised by their verified identity id, leaves, though staff stay (`patient_left`). The empty-room grace of the patient's own room does not apply;
- if the patient does not arrive within `RECORDER_BOT_PATIENT_WAIT_SECONDS`, or the consultation is stopped early before they arrived, it stops and **nothing is kept**: status `discarded`, and its folder leaves the spool;
- its evidence recording is kept under the patient's HN like any other, and its manifest names the `station`.

A station consultation needs verified identities (see [Verified identities](#verified-identities)): the patient is recognised by the identity's `id`.

### Evidence recordings

Each consultation's evidence recording is one folder in the storage root:

```
<storage root>/<backend-safe HN>/<consultation start>/
```

The backend-safe HN is the room name. The consultation start is when the service was asked to record it, in UTC and ISO 8601 basic format, which has no `:` (some file servers refuse it in names). HN `12345/67`, asked for at 09:15:02.120 UTC on 31 October 2026, goes to `12345%2f67/20261031T091502.120Z/`.

The folder holds:

| File | What |
|---|---|
| `NN-<endpoint id>-audio.webm` | One participant join's audio: Opus at 64 kbps |
| `NN-<endpoint id>-video.webm` | One participant join's video: VP8 at up to 1.5 Mbps, at whatever resolution the participant sent, changes included |
| `timeline.json` | Every join, with the participant's verified identity and role, leave, track start and stop, video resolution change, and interruption of the bot, in order, with its time |
| `manifest.json` | The summary below |

`NN` numbers the files in the order their tracks started. A participant who rejoins has a new endpoint id, so their rejoin is recorded to new files.

`manifest.json` holds:

| Field | What |
|---|---|
| `consultationId`, `hn`, `room`, `meetingId` | Which consultation. `meetingId` is the conference's id in the Jitsi logs |
| `station` | The station's room, when the consultation took place in one |
| `start`, `end`, `stopReason` | When it started and stopped, and why it stopped |
| `participants` | For each participant join: `endpointId`, `displayName`, `identity` (`id` and `name`, when verified), `role`, and the times in `joins` and `leaves` |
| `identities` | For each verified identity, across its rejoins: `identity`, `role`, its `endpointIds`, one per join, and its `files` |
| `files` | For each file: `name`, `kind`, `endpointId`, `start` and `stop` on the timeline, `duration` in seconds and `bytes` |
| `staffVisits` | Each staff visit, from a staff member's join to their leave: `identity`, `displayName`, `endpointId`, `start` and `end`. A visit still open at the stop ends then |
| `gaps` | Each stretch the bot did not record, from a crash or lost connection (`start`) until the relaunched bot was back, or the consultation stopped (`end`) |

While a consultation runs, each track is written to the spool in one-second chunks. Once it stops, the service closes every recorder, remuxes each file with a stream copy so that it has a duration and is seekable, writes `timeline.json` and, last, `manifest.json`, then moves the folder into the storage root. On the same filesystem the move is a rename. Otherwise the folder is copied into `<storage root>/.incoming/` first and then renamed into place, so a consultation folder in the storage root is always complete. Leave `.incoming` alone.

### When the storage root is unavailable

When the storage root is unavailable as a consultation ends, for example because its share is not mounted or the file server is down, the finalised folder stays in the spool and the consultation is `spooled`, with `error` `store_failed: <code>`. The code is `NO_STORAGE_ROOT_MARKER` when the storage root is there but has no marker file (see [Running it](#running-it)), as an unmounted mount point has none. The service retries every spooled folder when it starts and then every `RECORDER_BOT_STORE_RETRY_SECONDS`. Once the move succeeds, the consultation is `stored` and `evidenceLocation` says where the evidence recording is.

A failed attempt leaves nothing in the storage root: its partial copy in `.incoming` is removed, and so is the patient's folder when the attempt created it. The service never creates the storage root itself, so that evidence never lands on the local disk under a share that is not mounted. Keep the spool on a persistent volume with room for the evidence recordings of the longest time the storage root may be unavailable.

The logs name each spooled evidence recording by its consultation id: `could not move a spooled evidence recording to the storage root; will retry` at each failed attempt, with the error code, and `spooled evidence recording stored` once it is moved.

After a restart, the control API no longer knows earlier consultations; their spooled evidence recordings are still retried, and logged by consultation id. A folder in the spool without `manifest.json` was never finalised: the service stopped while that consultation ran, or could not finalise it. The service leaves it there and logs `an evidence recording in the spool was never finalised` once after each start; the recorded media is in its `raw/` folder.

### Retention

ADR 0003 keeps evidence recordings for three months, then deletes them. The service does that itself: when it starts, and then every `RECORDER_BOT_RETENTION_SWEEP_SECONDS`, it deletes

- every evidence recording in the storage root whose consultation start is older than `RECORDER_BOT_RETENTION_DAYS`, and the patient's folder once it is empty;
- every consultation folder in the spool, and in the storage root's `.incoming`, in which nothing has changed for longer than that: what a crash, or a storage root unavailable for that long, left behind.

It deletes only what matches the evidence layout: a `<backend-safe HN>/<consultation start>/` folder whose `manifest.json` names that same place, or a folder named after a consultation id in the spool. It never deletes the folder of a consultation still in progress, and never follows a symbolic link. Every other folder or file it leaves alone, and logs once after each start, as `leaving alone a folder that does not match the evidence layout`, with a `reason` and a `folder`. It ignores names that start with `.`, such as a file server's snapshots.

To delete a folder, the service first renames it into `.deleting` next to it, in the storage root or the spool, then deletes it there. A deletion cut short, by a crash for example, is finished by the next sweep; leave `.deleting` alone.

The logs name each deleted folder by its consultation id, with `place` `storage_root`, `spool` or `staging`, and never by HN. The `folder` of a folder left alone is the first 16 hexadecimal digits of the HMAC-SHA256 of its path relative to the storage root, or to the spool, keyed with `RECORDER_BOT_API_SECRET`, so that the log names no HN, and nobody without the secret can find the HN by hashing every HN. To find it, from the storage root, with the secret in `RECORDER_BOT_API_SECRET`:

```bash
find . -mindepth 1 -maxdepth 2 -printf '%P\n' | while read -r p; do printf '%s %s\n' "$(printf '%s' "$p" | openssl dgst -sha256 -hmac "$RECORDER_BOT_API_SECRET" -r | cut -c1-16)" "$p"; done
```

When several services share one storage root, each of them sweeps it; that is safe.

### Logs

The service's logs are JSON lines on standard output. They carry the consultation id and no patient data; lib-jitsi-meet's own logs, which name the room, are kept out.

## Testing

`../test-deployment/` runs this fork's web build with the recorder bot service on one machine, and the WebdriverIO suite's `specs/recorderBot` tests run against it.
