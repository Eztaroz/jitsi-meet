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
| `front/` | The front web server's image: nginx that ends TLS and shows the maintenance page (`maintenance/index.html`) while the web server restarts |
| `nginx/videos.conf`, `custom-config.js` | Served videos and the client's role markers |
| `keys/` | Public keys the web server serves to Prosody (`asap/`, `coordinator-public/`), and the coordinator service's private key (`coordinator-private/`) |
| `videos/` | The waiting video files, at `/videos/` |

## Setting up a host

Needs Docker with the Compose plugin, a clone of this repository at the release to deploy, and the hospital's TLS certificate (full chain) and key. All paths below are relative to this directory.

1. **Build the web and the images**, from the repository root:

   ```sh
   make all
   docker build -f deploy/production/front/Dockerfile -t front:<version> .
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
| TCP 443 (and 80, which redirects), on the front web server | Users and the hospital's systems | The web client, BOSH and websockets, `/coordinator/` |
| UDP 10000 | Users | Media through the videobridge |
| UDP 3478, TCP 5349 | Users | coturn (STUN/TURN, TURN over TLS) |
| `127.0.0.1:8090`, `:8094` | This host only | The recorder bot's and the video player's control APIs, for health checks |
| 8091 (coordinator), 5280 (Prosody HTTP) | Nothing | Internal network only. **Never publish them** |

The old server had no firewall; this host should have one that allows only the rows above (and SSH from the administrators' network).

## Day 2

- **Health:** `curl -s http://127.0.0.1:8090/health`, `curl -s http://127.0.0.1:8094/health`, and `curl -sk https://<host>/coordinator/health` with the bearer secret `COORDINATOR_API_SECRET`.
- **Logs:** `docker compose logs -f --tail 200 <service>`.
- **Update:** build the new images, change their tags in `.env`, `docker compose up -d`. A recorder bot being replaced has a minute to finalise the consultations in progress; do it between visits. After a change to a Prosody module, restart `prosody`, then `jicofo` and `jvb`.
- **Back up:** the `coordinator-data` volume (encounters, audit log, surveys) unless the coordinator service keeps its state in the hospital's MariaDB (`COORDINATOR_MARIADB_HOST` in `.env`; then the database team's backups hold it, see `coordinator/deploy/README.md`, "State in MariaDB"), the `recorder-bot-spool` volume while evidence recordings wait in it, `.env`, `keys/coordinator-private/`, `coordinator/rooms.json`.
- **Certificates:** one certificate serves the web server and coturn. After renewing it in place, `docker compose restart web coturn`. `scripts/preflight.sh` warns 30 days ahead of expiry; run it from a daily check, because the old server's coturn certificate expired unnoticed.
- **Secrets:** a change to a service's API secret needs the same change in whoever calls it (`RECORDER_BOT_API_SECRET` is also the coordinator's; `COORDINATOR_API_SECRET` is the hospital system's).

## The front web server and the maintenance page

The `front` service (ADR 0017) is the only one that publishes ports 80 and 443. It ends TLS with the hospital's certificate and forwards everything, websockets included, to `web`, which speaks plain HTTP on the internal network (`DISABLE_HTTPS=1`). Prosody and the bots still reach `web` directly, on the internal network.

While `web` restarts (it is stopped, being recreated, or does not answer within 3 seconds) `front` answers every request with the maintenance page, `maintenance/index.html`, with status `503`, `Retry-After: 60` and the header `X-Maintenance: 1`. Nothing changes for the user: same address, and the service is back as soon as `web` answers. A `5xx` that `web` itself sends is passed on, not replaced.

- **Health:** `curl -sk https://<host>/front-health` answers `ok` from `front` alone. For `web`, check that the page is served and carries no `X-Maintenance` header: `curl -skI https://<host>/ | grep -i x-maintenance` must print nothing.
- **Change the page** by editing `maintenance/index.html` (its CONFIG block holds the dates and the contact), and the nginx settings in `front/front.conf`. Both are baked into the image, so a change reaches production only when the new `front` image is deployed with the central stack, **in the night window (22:00 to 05:00) only**: restarting `front` cuts every connection. The pipeline builds `front` like the other images, and the 22:00 trigger redeploys the stack.
- **Try it** on the test deployment (outside any consultation): `docker compose stop web` (or restart it from Portainer), open the address: the maintenance page; start `web`: the service, with no change of address.

## Not for this deployment

- The mobile apps (ADR 0010): Prosody refuses a client that does not announce it can be moved, so users open the link in a phone's browser.
- Breakout rooms (ADR 0007), peer-to-peer media (ADR 0002), guests, and dial-in. Adding Jigasi later means adding its host to `muc_require_move_support_exempt_hosts` in `docker-compose.yml`.

## Portainer and GitLab CI

`docker-compose.portainer.yml` is this deployment as a Portainer stack that is updated by GitLab CI. It mounts nothing from the
repository: the images carry the front web server's configuration (`front/Dockerfile`), the web build (`web/Dockerfile`), the nginx settings, the Prosody plugins (`prosody/Dockerfile`)
and the services. The generated configuration of the docker-jitsi-meet services is in named volumes. What stays on the Docker
host, under `DATA_DIR`: `keys/` (`asap`, `coordinator-public`, `coordinator-private/private.pem`), `coordinator/rooms.json`,
`coturn/turnserver.conf` (rendered by `scripts/generate-secrets.sh`) and `videos/`. Run the scripts once, in `DATA_DIR`.

```text
push to the default branch (GitLab)
  → test-coordinator
  → image-coordinator, image-recorder-bot, image-video-player, image-prosody   (kaniko; :latest and :<commit>)
  → image-front                       (nginx: TLS and the maintenance page)
  → image-web                         (on its own runner: webpack needs about 4 GB)
22:00, a cron job calls the pipeline trigger with DEPLOY_CENTRAL=1 (every job below refuses outside 22:00-05:00)
  → deploy-stack: the test stack's webhook, then every health check, reported
  → central-promote: :production of coordinator, prosody, web and front moves to this commit's build
  → central-verify: the production central stack's webhook, then every health check, 2 minutes at most
  → (only on a failure) central-rollback-tag, central-rollback-redeploy: :production back to the previous build, redeployed
deploy-stack-now (by hand): the test stack, at once, at any hour
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

### The night deployment of the central services (ADR 0017)

The scripts are in `scripts/ci/`; `scripts/test/run-tests.sh` tests them against local fake servers and a fake `crane`
(needs sh, curl and node; it touches no registry and no Portainer).

- **Window:** `night-window.sh` allows 22:00 to 05:00 Bangkok time (UTC+7, computed, as the images have no time zone data).
  `promote-central.sh` and `redeploy-central.sh` call it, so a trigger started at noon deploys nothing. A rollback and the
  manual `deploy-stack-now` do not check it.
- **Healthy** (`central-health.sh`, every 5 seconds for 2 minutes, one line per check): the coordinator service's health is
  200 and `active` (it holds the database lock); `/front-health` answers; the page and `/config.js` are served without the
  `X-Maintenance` header; Prosody's BOSH endpoint (`/http-bind`) answers; Jicofo's and the videobridge's own health checks
  answer 200; and the coordinator service can list `/rooms`. A check without its variable fails, it is never skipped.
- **Rollback:** `promote-central.sh` records the digest `production` had (`central-previous.env`, an artifact) before it moves
  the four images; if `central-verify` fails, `rollback-central.sh` moves `production` back and the stack is redeployed, and
  the pipeline stays failed. Jicofo and the videobridge are upstream images pinned by `JITSI_IMAGE_VERSION`: the stack is one
  step, and a change of that version is rolled back by changing it in the stack's environment.
- **Set up once, on the production central stack:** `IMAGE_TAG=production`. Jicofo's and the videobridge's health ports
  (8888, 8080) are published on `HOST_INTERNAL_IP` only; the runner must reach them there. CI/CD variables: see the header of
  `.gitlab-ci.yml` (`PRODUCTION_WEBHOOK`, and for `TEST_` and `PRODUCTION_`: `URL`, `COORDINATOR_SECRET`, `JICOFO_HEALTH_URL`,
  `JVB_HEALTH_URL`).

Roll back by setting `IMAGE_TAG` to a commit hash and updating the stack.

## Deploying the workers (ADR 0017)

Every build merged to the main branch reaches the recorder bots and the video players one at a time, with no consultation cut. The job `deploy-workers` runs `deploy/pipeline/deployWorkersMain.ts` after the images are pushed (`latest` and the commit's first 8 characters, which the images also carry as their build, in `RECORDER_BOT_BUILD` / `VIDEO_PLAYER_BUILD`). For each worker, in order of kind and id, it:

1. does nothing if the worker already runs the build; leaves a lost worker alone;
2. for a recorder bot, requires at least two recorder bots in service (not lost, not draining); with fewer, the recorder bot is left for the night window;
3. sets the worker draining (`PUT /workers/<id>/draining` with the pipeline's secret) and polls `GET /workers` until it runs nothing (up to 4 hours; if it still runs something, it sets it taking work again and stops, nothing deployed);
4. moves the tag `production-<id>` of its image to the build (a registry manifest copy, no daemon) and calls the webhook of its VM's stack, which pulls that tag;
5. waits up to 2 minutes for a heartbeat with the new build, not lost, and (when `HEALTH_URL_<ID>` is set) a passing health check;
6. sets it taking work again.

If step 5 fails, the tag goes back to the worker's previous build, the webhook is called again, and the pipeline stops before the next worker (the job fails). If the previous build cannot be restored either, the worker is left draining, for a person. A worker left draining blocks the next deployment, which refuses to start while any worker is draining.

`production` itself moves to the build only after every worker of that image is healthy on it (and none was left for the night window), so the central stack and a new VM follow only good builds.

Set up once, for each worker VM: its stack's `IMAGE_TAG` is `production-<worker id>` (the worker's id in the coordinator service's list; characters other than letters, digits, `_`, `.`, `-` become `-`), and it carries no `RECORDER_BOT_BUILD` of its own. CI/CD variables of the project, none of them in the repository:

| Variable | What |
|---|---|
| `COORDINATOR_URL` | The coordinator service's address as the runner reaches it. Unset: the job is skipped |
| `COORDINATOR_PIPELINE_SECRET` | The pipeline's own secret (the coordinator service's `COORDINATOR_PIPELINE_SECRET`), Protected and Masked |
| `WEBHOOK_<ID>` | The webhook of the stack of that worker's VM; the id in capitals, other characters `_` (`bot-1` is `WEBHOOK_BOT_1`), Protected |
| `HEALTH_URL_<ID>`, `HEALTH_SECRET_<ID>` | Optional: the worker's own health check, if the runner can reach it, and its bearer secret |
| `ALLOW_SELF_SIGNED` | `1` when the coordinator service, Portainer or the registry use a certificate the runner does not know |
| `ALLOW_SINGLE_RECORDER_BOT` | `1` only in the night window's call: the `deploy-workers-night` job of the trigger pipeline sets it, after the central services, so that workers left over and a lone recorder bot are deployed at night |

The registry must let `REGISTRY_AUTH`'s user push tags. The job runs for as long as consultations take to finish, so the project's job timeout must allow hours. This GitLab has no `resource_group`: the guard against two deployments at once is the refusal to start while a worker is draining.

Test it without Portainer: `node --test deploy/pipeline/test/*.test.ts` runs the script against a fake coordinator service, fake webhooks and a fake registry.
