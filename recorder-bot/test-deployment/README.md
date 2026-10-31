# Recorder bot: local test deployment

A Jitsi deployment on one machine, for testing the recorder bot. It runs docker-jitsi-meet's images, serves this fork's own web build in place of the image's, and runs the recorder bot service. It is not for production: its passwords are fixed and public, and the bot accepts the web server's self-signed certificate.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret` |
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

`.env` holds the deployment's settings; the containers write their generated configuration to `config/`. After a web rebuild, reload the page; after a change to the service, rebuild its image and run `docker compose up -d recorder-bot`.

## Running the end-to-end tests

The WebdriverIO suite's `specs/recorderBot` tests run against this deployment. `tests.env` points the suite at it and sets the `recorderBot.available` expectation through `expectations.json`. From `tests/`:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; set +a
```

```bash
npm run test-single -- specs/recorderBot/hiddenBot.spec.ts
```

Where wdio cannot download Chrome or chromedriver, set `CHROME_BINARY` and `CHROMEDRIVER_BINARY` (see `tests/env.example`).

## Stopping it

```bash
docker compose down
```
