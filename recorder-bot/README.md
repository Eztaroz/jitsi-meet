# Recorder bot

The recorder bot records every telemedicine consultation as an evidence recording. See the spec in issue #2 and the decisions in `docs/adr/0001` to `0005`.

This is a standalone package, like `tests/`. It has its own dependencies, runs on Node, and nothing in it goes into the web bundle.

## Layout

| Path | What |
|---|---|
| `src/main.ts` | The service's entry point: the control API, the spool retrier and the retention sweeper, and shutdown on `SIGTERM`. |
| `src/api.ts` | The control API (`POST /consultations`, `GET /consultations/{id}`, `GET /health`), behind a bearer secret. |
| `src/consultations.ts`, `src/consultation.ts` | The running consultations. Each one feeds the bot's events to its lifecycle module, collects the timeline entries the module returns, carries out its commands, and relaunches a bot that crashed or lost its connection. |
| `src/consultationLifecycle.ts` | The consultation lifecycle module. It is pure: it takes timestamped events and returns timeline entries and commands (start a timer, cancel a timer, stop). It owns the stop rule and decides the timeline entries, and derives the participants, tracks, verified identities, staff visits and gaps. |
| `src/evidence.ts` | The evidence recording on disk: track files in the spool while the consultation runs, then the remux, `timeline.json`, `manifest.json` and the move into the evidence storage root. A worker (one that has `RECORDER_BOT_ID`) stores its part in a folder of its own, `<HN>/<consultation start>/<worker id>/`, and rewrites the consultation's `manifest.json` above it to list the parts stored so far and their gaps, so that a consultation taken over by another recorder bot (ADR 0016) never has one part overwrite another; the part of a lost VM is listed once that VM stores it. The coordinator service tells the recorder bot that takes a consultation over which worker it took it from (`takenFrom`); that bot writes the lost worker's part as `awaiting` in its own part's manifest, and the consultation's manifest then says `complete: false` and lists it in `missingParts` until that part is stored in the evidence storage root. `review` takes a part's folder. |
| `src/spool.ts` | Retries moving the evidence recordings left in the spool, while the storage root was unavailable, into the storage root: at start-up and then periodically. |
| `src/retention.ts` | The retention sweeper: deletes evidence recordings older than the retention period, and stale spool folders. |
| `src/periodic.ts` | Runs the spool retrier and the retention sweeper at start-up and then periodically. |
| `src/identity.ts` | A participant's verified identity and role, from the identity Prosody puts in its presence and the role markers. |
| `src/bot.ts` | Runs the bot page in its own headless Chromium, one browser per consultation, and passes on its events and recorded chunks. |
| `src/roomName.ts` | The room name for an HN, normalised as jitsi-meet normalises a URL room name. |
| `src/review.ts`, `src/reviewPlan.ts`, `src/reviewRender.ts` | The `npm run review` command, which makes a Review file of one evidence recording: the plan (where each tile goes, which file fills it when, the gaps) and its rendering with ffmpeg. |
| `src/config.ts`, `src/log.ts` | Settings from the environment, and the JSON-lines logger. |
| `../static/recorder-bot.html`, `../static/recorder-bot.js` | The bot page. The deployment's web server serves it with the rest of the web build; it joins with the deployed lib-jitsi-meet, records each remote audio track with its own `MediaRecorder`, copies each remote video track as the sender encoded it (AV1, VP9 or VP8, through a WebRTC Encoded Transform, written as an IVF stream that the service remuxes to WebM without re-encoding; a track it cannot copy falls back to `MediaRecorder` and is logged as a recorder error), and reports what happens to the service. |
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

Start the service with `npm start`; `deploy/README.md` lists its settings. It needs `ffmpeg` and `ffprobe` on `PATH`; the image has them.

### Review file

An evidence recording keeps one file per participant track, which is hard to watch. To watch a consultation, make a Review file of it:

```bash
npm run review -- <evidence recording folder> <output file>
```

It writes one MP4 of the whole consultation: every participant side by side on a 1280x720 canvas, in the order they first joined, with all their audio mixed into one track. Each tile shows the participant's display name, role and the wall-clock time; a participant who is not there yet, or has left, is a black tile with their name, and during a gap every tile reads "not recorded" while the clock keeps running.

- **It is not evidence.** The evidence is the raw files in the evidence recording, and they stay the only evidence. The command only reads the folder: it never writes into it, and refuses an output file inside it.
- **It is made on request, and not stored.** Make it when someone needs to watch a consultation, keep it outside the evidence storage root, and delete it when done; it can always be made again. The service never makes one, and has no endpoint or setting for it.
- It needs `ffmpeg` and `ffprobe` on `PATH`; in the image, run it with `docker exec <container> npm run review -- ...`.
- The clock is in the local time zone of wherever the command runs. Set `TZ`, for example `TZ=Asia/Bangkok npm run review -- ...`, when that is not the hospital's (the image runs in UTC).
- The labels need a font with Thai and Latin glyphs. The command finds one with fontconfig; where there is none, as on Windows, pass a font file with `--font <file>`, for example `--font C:\Windows\Fonts\tahoma.ttf`.
- Relative paths are taken from the folder you run `npm` in.

The TypeScript sources run directly on Node 22.18 or later, which strips types without a build step. That is why imports name `.ts` files and the sources use only erasable syntax: no `enum`, no `namespace`, no parameter properties.
