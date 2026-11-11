# Plan: replacing the old production server

The old server, `telemedicine.example.org` (`192.0.2.10`, public `203.0.113.10`), runs the stock Jitsi Debian packages. This plan replaces it with the Docker deployment in this directory, on a new host, and keeps the old one untouched until the new is proven, so that going back takes minutes.

## What the old server is

Read-only inspection, 2026-11-10:

| | |
|---|---|
| Host | Ubuntu 24.04, 7.7 GB RAM, load average near zero; two interfaces, one for users and one internal |
| Install | Debian packages: jitsi-meet 2.0.11031, prosody 13.0.6, jicofo, jitsi-videobridge2, coturn 4.6.1, nginx; no Docker |
| Auth | Prosody `authentication = "token"`, `app_id` `tele-med`, a shared `app_secret` (HS256); Jicofo `authentication.type = JWT` |
| Rooms | `restrict_room_creation`, lobby on, breakout rooms on (nobody uses them), P2P off, prejoin, welcome page and deep linking off |
| Media | JVB with `static-mappings` `192.0.2.10` to `203.0.113.10`; coturn on 3478 and 5349 |
| TLS | nginx uses a wildcard certificate that expires 2026-12-09; coturn's own certificate expired 2026-11-05 |
| Not there | Firewall (`ufw` off, empty iptables), Jibri, Jigasi, any of this fork's services |
| Web | Stock upstream bundle, no trace of this fork's code |

## What changes for the hospital's systems

1. **The token issuer signs with RS256** and publishes a public key, instead of an HS256 secret ([JWT-CONTRACT.md](JWT-CONTRACT.md)). It must also set `context.user.id` and `context.user.hospital_role`.
2. The hospital's system calls the **coordinator service** (`https://<host>/coordinator/...`, bearer secret) to start an encounter, instead of only handing out links. The coordinator asks the recorder bot to record.
3. Mobile apps stop working; browsers on phones do (ADR 0010).
4. Breakout rooms are gone (ADR 0007).

## Decisions taken

- Docker, on a **new host**; the old server is not touched.
- The XMPP domain stays docker-jitsi-meet's internal `meet.jitsi`; the public name is `telemedicine.example.org`.
- Issuer `tele-med`, audience `jitsi`, roles by `context.user.hospital_role`.
- The whole fork is deployed at once: web, recorder bot, coordinator, video player.

## Phase 0: before anything (needs the hospital)

| Item | Detail |
|---|---|
| New host | Ubuntu LTS with Docker and Compose. Size by the recorder bot: about one CPU core per recorded 720p video track (a patient and one staff member is about two cores), 0.4 GB RAM per pair, plus the videobridge, Prosody and the video player. Start from **8 vCPU, 16 GB RAM, 200 GB disk** and set `RECORDER_BOT_MAX_CONSULTATIONS` to about half the cores. The 2 vCPU test VM is too small |
| Addresses | An internal address for the host. At the cut-over it takes over `192.0.2.10`, or the NAT and DNS are repointed to it |
| NAT/firewall | Public `203.0.113.10` forwards TCP 80/443, UDP 10000, UDP 3478, TCP 5349 to the host |
| Test name | A name under the wildcard for the parallel run, such as `telemedicine-new.example.org`, pointing at the new host: the wildcard certificate covers it |
| Certificate | The wildcard certificate and key, the key `chmod 600` and root's only; a renewal plan that restarts `web` and `coturn` |
| Evidence storage | The hospital's file storage mounted on the host; space of about 680 MB per 30-minute consultation times the consultations a day times 90 days |
| Issuer team | The [token contract](JWT-CONTRACT.md) handed over, and a date for their RS256 work and for the switch at the cut-over |
| Content | The hospital's `rooms.json` (centers, stations, pathways, questionnaires) and the waiting videos |
| Mobile browsers | Real iOS Safari (current and previous) and Android Chrome for `coordinator/deploy/mobile-browser-checklist.md`, which has never been run |

## Phase 1: build

On a build machine, at the release to deploy: `make all`, then the three images (README, step 1), tagged with the release. Record the tags.

## Phase 2: install the new host

Follow the README, steps 1 to 6, with `PUBLIC_HOST`/`PUBLIC_URL` set to the **test name**. Then also:

- Install Docker, log rotation (`/etc/docker/daemon.json`), a firewall that opens only the ports in the README, unattended security updates.
- The certificate key is `chmod 600` and kept outside any home directory.
- Set `JITSI_IMAGE_VERSION` to a pinned docker-jitsi-meet tag the end-to-end suite has passed on.

## Phase 3: the unverified settings

These were written from the documentation and the test deployment, and not run: check each on the new host before trusting it.

| Assumption | Check |
|---|---|
| `front` reads its certificate from `/etc/tele-meet/certs/cert.crt` and `cert.key` when they are mounted, and `web` speaks plain HTTP behind it (`DISABLE_HTTPS`) | `docker compose exec front ls -l /etc/tele-meet/certs`; `openssl s_client -connect <test name>:443` shows the hospital's certificate; `docker compose stop web` shows the maintenance page at the same address (503, header `X-Maintenance`), `docker compose start web` brings the service back |
| The image variables `TURN_HOST`, `TURN_PORT`, `TURNS_HOST`, `TURNS_PORT`, `TURN_CREDENTIALS` configure Prosody's `external_services` | `docker compose exec prosody grep -A6 external_service /config/conf.d/*.cfg.lua` shows UDP 3478 and TLS 5349 with a secret; a client gets TURN credentials |
| `coturn/coturn:4.6.3` exists and accepts the rendered `turnserver.conf` | `docker compose logs coturn`; test with Trickle ICE (relay candidates over UDP and over TLS 5349) |
| `ENABLE_CLOSE_PAGE=false` is understood by the image | The left page (`static/left.html`) shows after hanging up |
| `JVB_ADVERTISE_IPS` takes the two addresses | `docker compose exec jvb grep -r advertise /config/`; a client on the internal network and one outside both connect |
| `extra_hosts` lets the bots reach the web server and the videobridge | A recording starts and has video from both sides |
| `ENABLE_BREAKOUT_ROOMS=false` hides the buttons | The toolbar has no breakout rooms |

## Phase 4: run beside the old server

The old server keeps serving users. On the test name:

1. The issuer team issues RS256 test tokens for the new host only.
2. Functions, with real browsers and tokens of each role:
   - A patient and a staff member in the HN's room; audio and video both ways; with a third participant (media through the videobridge in every case, P2P is off).
   - From an office network, from the hospital Wi-Fi, from a phone's browser, and from behind a restrictive firewall (TURN over UDP and over TLS).
   - A recording starts when the encounter starts, ends when the room empties, and the file lands in the storage root with the marker; the retention sweep deletes old ones.
   - Coordinator: sign in to `/coordinator/screen`; start an encounter; stages and queues; move a staff member (five-second countdown, "Stay here"); the audit log.
   - Staff requests from the call: call the next patient, change the stage, send a questionnaire and read the answers.
   - Waiting video: it plays, a staff member joining stops it, a patient cannot stop or mute it.
   - Patient safety: never a moderator; no one can end the room or kick the patient.
   - Satisfaction survey, and the CSV report.
   - A HN with `/` (`12345%2F67`) joins the same room for the patient and the recorder.
   - A mobile app is refused with "This client cannot be moved between rooms".
   - Restart `coordinator`, `recorder-bot`, `prosody`: encounters survive, consultations finalise, reconnection works.
3. Load: as many rooms as `RECORDER_BOT_MAX_CONSULTATIONS` at once with real cameras, watching the CPU; the next consultation must be refused with `503`, not recorded badly. Write the measured CPU per consultation into `recorder-bot/deploy/README.md` (Capacity) and set `RECORDER_BOT_MAX_CONSULTATIONS` per worker from it, with at least 25% of the cores free for cameras that change resolution, a shared screen and consultations finalising together.
4. The end-to-end specs under `tests/specs` that cover the recorder bot and the coordinator, against the test name, from a host big enough that their timers hold.
5. Run `scripts/preflight.sh` daily from now on.

Exit criteria: every item passes, the mobile-browser checklist is done, and the issuer team has signed off.

## Phase 5: cut over

Pick a quiet time and tell the users that open calls will drop.

**Before** (days ahead): lower the DNS TTL; set `PUBLIC_HOST`/`PUBLIC_URL` in `.env` to the production name and `docker compose up -d` the new host; confirm the certificate is the wildcard; leave the old server running.

**Switch**, in this order, with the issuer team on the line:

1. Announce the window. Stop issuing links for new visits, wait for open calls to end where possible.
2. Move the traffic: give the new host `192.0.2.10` (the old server gets a spare address), or repoint the NAT `203.0.113.10` and the DNS name at the new host.
3. Switch the issuer to RS256 with the published key, and the hospital system to call the new coordinator.
4. Check as in Phase 4: one patient, one staff, a recording, the coordinator screen, TURN.

**Roll back** (minutes), if any check fails and it cannot be fixed at once:

1. Move the address, NAT and DNS back to the old server (still running, untouched).
2. Switch the issuer back to HS256 with the old `app_secret`.
3. Check one call. Then investigate; nothing was lost on the old server.

Keep the old server, switched on and unchanged, for **two weeks**, with its sudo and SSH key access for the inspection removed.

## Phase 6: afterwards

- Watch for two weeks: free disk (spool and storage), `GET /health` of each service, Prosody and Jicofo errors, refused consultations (`503`), certificate expiry alerts.
- Back up as the README says, and test one restore.
- Review the audit log and the retention (`RETENTION_DAYS`, 90) with the hospital's data protection officer: the survey and the recordings hold patient data under the PDPA.
- Retire the old server after two uneventful weeks. Delete its home-directory copies of the certificate and key.

## Risks

| Risk | Mitigation |
|---|---|
| The issuer cannot change in time | The cut-over waits; the old server keeps serving. There is no half-way: Prosody verifies one algorithm for the participants |
| The signing key of the issuer or the coordinator leaks | Either can join any room: keys are root-only or the service's alone; `scripts/publish-issuer-key.sh` refuses private keys; keys are rotated by publishing the new beside the old |
| Too many recordings at once | `RECORDER_BOT_MAX_CONSULTATIONS` comes from the measured CPU per consultation with headroom, and a full bot answers `503` |
| The unverified settings (Phase 3) are wrong | Found on the parallel run, before the cut-over |
| Certificate expires again | Preflight check in a daily job, alert at 30 days |
| Users on the mobile apps | Announce beforehand; browsers work |
| The recorder cannot reach the evidence storage | The service spools locally and retries (`recorder-bot/deploy/README.md`); monitor the spool size and mount |
