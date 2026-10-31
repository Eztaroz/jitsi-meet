# Recorder bot: operator guide

The recorder bot records patient consultations as evidence. The hospital's room-creation system asks the recorder bot service to record a patient's consultation by HN; the service starts a headless Chromium for that consultation, and the bot joins the patient's room as a hidden participant. Nobody in the call sees the bot. The bot is never a moderator. It leaves when staff end the meeting for everyone.

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

docker-jitsi-meet: `ENABLE_RECORDING=1`, `XMPP_HIDDEN_DOMAIN=recorder.meet.example.org`, `JIBRI_RECORDER_USER=recorder-bot` and `JIBRI_RECORDER_PASSWORD=<bot password>` create the VirtualHost, register the account, and set `muc_lobby_whitelist` and, with `MAX_PARTICIPANTS`, `muc_access_whitelist`. Check `token_verification_allowlist` yourself when JWT is on.

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

The service's network must reach:

- the Jitsi web server at `RECORDER_BOT_JITSI_URL`, over HTTPS and its XMPP websocket;
- the videobridge's advertised address, on its media port (UDP 10000 by default).

Run one service per deployment. Each consultation runs in its own browser process, so a crash stays with one consultation.

### Settings

| Variable | Default | What |
|---|---|---|
| `RECORDER_BOT_API_SECRET` | required | The bearer secret every control API request must carry, `Authorization: Bearer <secret>` |
| `RECORDER_BOT_API_PORT` | `8090` | The control API's port |
| `RECORDER_BOT_JID` | required | The bot account, `recorder-bot@recorder.meet.example.org` |
| `RECORDER_BOT_PASSWORD` | required | The bot account's password |
| `RECORDER_BOT_JITSI_URL` | required | The Jitsi web server, `https://meet.example.org` |
| `RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS` | `60` | How long the bot stays once every human has left. A human who rejoins within it cancels the stop |
| `RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS` | `600` | How long the bot waits for the first human to join, counted from its own join |
| `RECORDER_BOT_MAX_HEIGHT` | `720` | The highest video resolution the bot asks the videobridge for |
| `RECORDER_BOT_CHROMIUM_PATH` | Playwright's | A Chromium binary to run instead |
| `RECORDER_BOT_IGNORE_CERTIFICATE_ERRORS` | `false` | Accept any certificate from the web server. Only for test deployments |

### Control API

Every request needs the bearer secret; without it the service answers `401`.

| Request | Answer |
|---|---|
| `POST /consultations` with `{ "hn": "<HN>" }` | `201` and `{ "consultationId", "status" }` |
| `GET /consultations/<consultationId>` | `200` and the consultation: `status`, `startedAt`, `stoppedAt`, `stopReason` |
| `GET /health` | `200` and `{ "status": "ok", "activeConsultations" }` |

The consultation id is an opaque UUID. The service's logs name consultations by this id, never by HN. The room name is the HN normalised as jitsi-meet normalises a URL room name: NFKC, lower-case, URL-encoded, lower-case again.

A consultation's `status` goes:

1. `starting` while the bot launches and joins;
2. `waiting_for_participants` once the bot is in the room, until the first human joins;
3. `recording` from then on, including while the room is empty within the grace;
4. `finalising`, then a final status, once it has stopped.

`stopReason` says why it stopped:

| Stop reason | When |
|---|---|
| `room_destroyed` | Staff ended the meeting for everyone. The bot stops at once, without leaving first |
| `no_humans_for_grace` | Every human left, and nobody came back within `RECORDER_BOT_EMPTY_ROOM_GRACE_SECONDS` |
| `no_one_joined` | Nobody joined within `RECORDER_BOT_FIRST_JOIN_WAIT_SECONDS` |
| `kicked` | A moderator removed the bot |
| `shutdown` | The service was stopped |

The service's logs are JSON lines on standard output. They carry the consultation id and no patient data; lib-jitsi-meet's own logs, which name the room, are kept out.

## Testing

`../test-deployment/` runs this fork's web build with the recorder bot service on one machine, and the WebdriverIO suite's `specs/recorderBot` tests run against it.
