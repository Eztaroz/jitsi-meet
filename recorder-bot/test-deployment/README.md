# Recorder bot: local test deployment

A Jitsi deployment on one machine, for testing the recorder bot. It runs docker-jitsi-meet's images, serves this fork's own web build in place of the image's, and runs the recorder bot service. It is not for production: its passwords are fixed and public, and the bot accepts the web server's self-signed certificate.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret` |
| A second recorder bot service, limited to one consultation at a time, for the capacity tests | http://localhost:8091, same secret |
| A third recorder bot service, which never relaunches a crashed bot, for the relaunch tests | http://localhost:8092, same secret |
| A fourth recorder bot service, with a storage root of its own, which the storage tests take away and give back and the retention tests seed. It retries spooled evidence recordings and sweeps every 2 seconds | http://localhost:8093, same secret |
| Videobridge media | UDP 10000, advertised as 127.0.0.1 |

The recorder bot service uses the host network, so that it reaches the web server on `localhost` and the videobridge on its advertised address, the way browsers on this machine do.

## Starting it

Build the fork's web bundles from the repository root:

```bash
make all
```

Build the service's image. Behind a TLS-inspecting proxy, add `--secret id=npm_ca,src=<proxy CA bundle>`:

```bash
docker build -t recorder-bot:local recorder-bot/
```

Start the deployment from this directory:

```bash
docker compose up -d
```

`.env` holds the deployment's settings, including a 10-second empty-room grace and a 20-second first-join wait so that the tests do not wait long; `expectations.json` tells the tests those values. The containers write their generated configuration to `config/`. After a web rebuild, reload the page; after a change to the service, rebuild its image and run `docker compose up -d recorder-bot`.

The services store evidence recordings in `evidence/`, their evidence storage root, and each keeps its spool in its own folder of `spool/`. The fourth service's storage root is `outage/evidence`, which is not there until the storage tests create it; they keep what earlier runs stored there in `outage/evidence-<time>`. The services run as root here so that they can write to these folders; delete what they wrote with `sudo` if you are not root.

## Running the end-to-end tests

The WebdriverIO suite's `specs/recorderBot` tests run against this deployment. `tests.env` points the suite at it, sets the `recorderBot.available` expectation through `expectations.json`, gives the evidence tests the storage root, and names the containers in which the relaunch tests kill bots' browsers and the storage tests restart the fourth service. The evidence tests play the stored files with `ffmpeg` and `ffprobe`, and the relaunch and storage tests run `docker`; they must be on `PATH`. From `tests/`:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; set +a
```

```bash
npm run test-single -- specs/recorderBot/hiddenBot.spec.ts
```

Where wdio cannot download Chrome or chromedriver, set `CHROME_BINARY` and `CHROMEDRIVER_BINARY` (see `tests/env.example`).

## The JWT variant

`docker-compose.jwt.yml` turns on JWT authentication, and Prosody's `presence_identity` module, so that the bot records each participant's verified identity and role (`recorder-bot/deploy/README.md`, Verified identities). `.env` sets the role markers for both variants; without JWT they mark nobody. Generate the key pair the tests sign tokens with, then start the deployment with both files:

```bash
./jwt/generate-keys.sh
```

```bash
docker compose -f docker-compose.yml -f docker-compose.jwt.yml up -d
```

Every participant then needs a token. Run the tests with `tests.jwt.env` on top of `tests.env`: only `specs/recorderBot/identity.spec.ts` runs, and the other recorderBot tests are skipped. From `tests/`:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; . ../recorder-bot/test-deployment/tests.jwt.env; set +a
```

```bash
npm run test-single -- specs/recorderBot/identity.spec.ts
```

To go back, run `docker compose up -d` without the JWT file; the containers regenerate their configuration.

## Stopping it

```bash
docker compose down
```
