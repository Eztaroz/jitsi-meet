# Recorder bot

The recorder bot records every telemedicine consultation as an evidence recording. See the spec in issue #2 and the decisions in `docs/adr/0001` to `0005`.

This is a standalone package, like `tests/`. It has its own dependencies, runs on Node, and nothing in it goes into the web bundle.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The service's entry point: the control API, and shutdown on `SIGTERM`. |
| `src/api.ts` | The control API (`POST /consultations`, `GET /consultations/{id}`, `GET /health`), behind a bearer secret. |
| `src/consultations.ts`, `src/consultation.ts` | The running consultations. Each one feeds the bot's events to its lifecycle module and carries out the module's commands. |
| `src/consultationLifecycle.ts` | The consultation lifecycle module. It is pure: it takes timestamped events and returns timeline entries and commands (start a timer, cancel a timer, stop). It owns the stop rule and derives staff visits and gaps. |
| `src/bot.ts` | Runs the bot page in its own headless Chromium, one browser per consultation. |
| `src/roomName.ts` | The room name for an HN, normalised as jitsi-meet normalises a URL room name. |
| `src/config.ts`, `src/log.ts` | Settings from the environment, and the JSON-lines logger. |
| `../static/recorder-bot.html`, `../static/recorder-bot.js` | The bot page. The deployment's web server serves it with the rest of the web build; it joins with the deployed lib-jitsi-meet and reports what happens to the service. |
| `Dockerfile` | The service's container image. |
| `deploy/` | The operator guide, the nginx snippet for HNs with `/`, and a compose file for docker-jitsi-meet deployments. |
| `test-deployment/` | A local deployment of this fork with the service, for the WebdriverIO suite's `specs/recorderBot` tests. |
| `test/` | Unit tests, run with Node's built-in test runner and its mock timers. |

## Commands

Run these from this directory after `npm install`:

```bash
npm test
```

```bash
npm run typecheck
```

Start the service with `npm start`; `deploy/README.md` lists its settings.

The TypeScript sources run directly on Node 22.18 or later, which strips types without a build step. That is why imports name `.ts` files and the sources use only erasable syntax: no `enum`, no `namespace`, no parameter properties.
