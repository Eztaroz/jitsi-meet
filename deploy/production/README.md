# Production deployment

The deployment of this fork on one Docker host: docker-jitsi-meet's images with token (JWT) authentication, this fork's web build, the recorder bot, the coordinator service, the video player and coturn. It replaces the old single-server Debian-package installation of `telemedicine.example.org`; [MIGRATION-PLAN.md](MIGRATION-PLAN.md) says how to move without stopping the old one until the new is proven, and [JWT-CONTRACT.md](JWT-CONTRACT.md) is what the hospital's token issuer must do.

It is the production counterpart of `coordinator/test-deployment` (which layers `recorder-bot/test-deployment` and its JWT variant), in one compose file. What differs from the test deployment:

| Test deployment | Here |
|---|---|
| Fixed, public passwords and secrets | Random ones, made once by `scripts/generate-secrets.sh` |
| Bots on the host network, reaching `localhost` | Bots on the internal network, resolving the public name to this host's address |
| `IGNORE_CERTIFICATE_ERRORS=true` | Never set: the bots check the real certificate |
| A self-signed certificate | The hospital's certificate, mounted read-only |
| Four recorder bot instances for the capacity and storage tests | One |
| `XMPP_DOMAIN` `meet.jitsi`, JWT issuer `chat` | The same XMPP domain (it is internal); issuer `tele-med` |

## What is in this directory

| Path | What |
|---|---|
| `docker-compose.yml` | The whole stack |
| `.env.example` | Every setting; `.env` is made from it and never committed |
| `scripts/generate-secrets.sh` | Makes `.env` with random secrets, and `coturn/turnserver.conf` |
| `scripts/generate-keys.sh` | The coordinator service's key pair and its public key in the key servers |
| `scripts/publish-issuer-key.sh` | Publishes a public key of the hospital's token issuer |
| `scripts/preflight.sh` | Checks, changes nothing, what must be true before starting |
| `coordinator/rooms.example.json` | The centers, stations, pathways, questionnaires and videos: copy it to `coordinator/rooms.json` and edit it |
| `coturn/turnserver.conf.template` | coturn, with the old server's settings |
| `nginx/videos.conf`, `custom-config.js` | Served videos and the client's role markers |
| `keys/` | Public keys the web server serves to Prosody (`asap/`, `coordinator-public/`), and the coordinator service's private key (`coordinator-private/`) |
| `videos/` | The waiting video files, at `/videos/` |

## Setting up a host

Needs Docker with the Compose plugin, a clone of this repository at the release to deploy, and the hospital's TLS certificate (full chain) and key. All paths below are relative to this directory.

1. **Build the web and the images**, from the repository root:

   ```sh
   make all
   docker build -t recorder-bot:<version> recorder-bot/
   docker build -t coordinator:<version> coordinator/
   docker build -t video-player:<version> video-player/
   ```

   Behind a TLS-inspecting proxy add `--secret id=npm_ca,src=<proxy CA bundle>` to each `docker build`.

2. **Make `.env`**, then set every `CHANGE_ME_*` value (the internal address, the advertised addresses, the image tags, `RECORDER_BOT_MAX_CONSULTATIONS`) and the certificate paths:

   ```sh
   scripts/generate-secrets.sh
   $EDITOR .env
   ```

   Keep `.env` as it is once the stack has run: the passwords are in Prosody's accounts.

3. **Make the keys**: the coordinator service's pair, and publish the issuer's public key (its owner gives you the key id and the file; see [JWT-CONTRACT.md](JWT-CONTRACT.md)):

   ```sh
   sudo scripts/generate-keys.sh
   scripts/publish-issuer-key.sh '<key id>' <issuer public key>.pem
   ```

4. **The storage root**: mount the hospital's file storage at `RECORDER_BOT_STORAGE_ROOT`, give uid 1001 write access, and create the marker once, on the share itself while it is mounted:

   ```sh
   touch "$RECORDER_BOT_STORAGE_ROOT/.recorder-bot-storage-root"
   ```

5. **The configuration**: `cp coordinator/rooms.example.json coordinator/rooms.json` and edit it for the hospital (see `coordinator/deploy/README.md`, "Settings" and "Pathways"). Put the waiting videos in `videos/` (the `file` of each in `rooms.json` is a path under the public URL).

6. **Check and start**:

   ```sh
   scripts/preflight.sh
   docker compose up -d
   docker compose ps
   ```

The first start of the Jitsi containers generates their configuration under `config/`.

## Ports

| Port | Open to | For |
|---|---|---|
| TCP 443 (and 80, which redirects) | Users and the hospital's systems | The web client, BOSH and websockets, `/coordinator/` |
| UDP 10000 | Users | Media through the videobridge |
| UDP 3478, TCP 5349 | Users | coturn (STUN/TURN, TURN over TLS) |
| `127.0.0.1:8090`, `:8094` | This host only | The recorder bot's and the video player's control APIs, for health checks |
| 8091 (coordinator), 5280 (Prosody HTTP) | Nothing | Internal network only. **Never publish them** |

The old server had no firewall; this host should have one that allows only the rows above (and SSH from the administrators' network).

## Day 2

- **Health:** `curl -s http://127.0.0.1:8090/health`, `curl -s http://127.0.0.1:8094/health`, and `curl -sk https://<host>/coordinator/health` with the bearer secret `COORDINATOR_API_SECRET`.
- **Logs:** `docker compose logs -f --tail 200 <service>`.
- **Update:** build the new images, change their tags in `.env`, `docker compose up -d`. A recorder bot being replaced has a minute to finalise the consultations in progress; do it between visits. After a change to a Prosody module, restart `prosody`, then `jicofo` and `jvb`.
- **Back up:** the `coordinator-data` volume (encounters, audit log, surveys), the `recorder-bot-spool` volume while evidence recordings wait in it, `.env`, `keys/coordinator-private/`, `coordinator/rooms.json`.
- **Certificates:** one certificate serves the web server and coturn. After renewing it in place, `docker compose restart web coturn`. `scripts/preflight.sh` warns 30 days ahead of expiry; run it from a daily check, because the old server's coturn certificate expired unnoticed.
- **Secrets:** a change to a service's API secret needs the same change in whoever calls it (`RECORDER_BOT_API_SECRET` is also the coordinator's; `COORDINATOR_API_SECRET` is the hospital system's).

## Not for this deployment

- The mobile apps (ADR 0010): Prosody refuses a client that does not announce it can be moved, so users open the link in a phone's browser.
- Breakout rooms (ADR 0007), peer-to-peer media (ADR 0002), guests, and dial-in. Adding Jigasi later means adding its host to `muc_require_move_support_exempt_hosts` in `docker-compose.yml`.

## Portainer and GitLab CI

`docker-compose.portainer.yml` is this deployment as a Portainer stack that is updated by GitLab CI. It mounts nothing from the
repository: the images carry the web build (`web/Dockerfile`), the nginx settings, the Prosody plugins (`prosody/Dockerfile`)
and the services. The generated configuration of the docker-jitsi-meet services is in named volumes. What stays on the Docker
host, under `DATA_DIR`: `keys/` (`asap`, `coordinator-public`, `coordinator-private/private.pem`), `coordinator/rooms.json`,
`coturn/turnserver.conf` (rendered by `scripts/generate-secrets.sh`) and `videos/`. Run the scripts once, in `DATA_DIR`.

```text
push to the default branch (GitLab)
  → test-coordinator
  → image-coordinator, image-recorder-bot, image-video-player, image-prosody   (kaniko; :latest and :<commit>)
  → image-web                         (on its own runner: webpack needs about 4 GB)
22:00, a cron job calls the pipeline trigger with DEPLOY_CENTRAL=1
  → deploy-stack: POST to the stack's webhook → Portainer pulls the new images and redeploys
deploy-stack-now (by hand): the same, at once
```

Set up once:

1. GitLab project CI/CD variables: `REGISTRY`, `IMAGE_PREFIX`, `REGISTRY_AUTH` (base64 of `user:password` for the
   registry) and `PORTAINER_WEBHOOK`. Internal names go there, not in the repo.
2. Run the pipeline, so that every image exists in the registry.
3. In Portainer, add a stack from this repository (`deploy/production/docker-compose.portainer.yml`), with the variables of
   `.env.example` as its environment, plus `REGISTRY_PREFIX` (the same as `IMAGE_PREFIX`), `IMAGE_TAG` (`latest`)
   and `DATA_DIR`. Turn on the stack's webhook, with "re-pull images", and put its URL in `PORTAINER_WEBHOOK`.
4. Add a pipeline trigger (Settings > CI/CD > Pipeline triggers), and on a host of the deployment a cron job that calls it
   every day at 22:00:

   ```sh
   0 22 * * * curl -sS -X POST -F token="$(cat ~/.gitlab-trigger-token)" -F ref=master        -F "variables[DEPLOY_CENTRAL]=1" "$GITLAB_URL/api/v4/projects/<project id>/trigger/pipeline"
   ```

Roll back by setting `IMAGE_TAG` to a commit hash and updating the stack.
