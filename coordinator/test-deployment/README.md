# Coordinator: local test deployment

The recorder bot's JWT test deployment (`recorder-bot/test-deployment`, with `docker-compose.jwt.yml`) plus the coordinator service. Not for production.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret`; the second recorder bot worker is at http://localhost:8095, secret `recorder-bot-2-test-secret` |
| Coordinator screen | https://localhost:8443/coordinator/screen |
| Coordinator API | https://localhost:8443/coordinator/, bearer secret `coordinator-test-secret` |
| Video player control API | http://localhost:8094, bearer secret `video-player-test-secret` (host network, like the recorder bot) |
| Waiting videos | https://localhost:8443/videos/intro.webm and `second.webm` |

The coordinator service publishes no port: it is on the deployment's internal network, and the web server's nginx proxies `/coordinator/` to it (`coordinator/deploy/nginx/coordinator.conf`). Prosody's HTTP port is not published either. The specs reach the service through the proxy.

Follow `recorder-bot/test-deployment/README.md` to build the web bundles and the recorder bot's image and to generate the JWT keys. Generate the coordinator service's own key pair, which Prosody uses to verify the service's calls:

```bash
./keys/generate-keys.sh
```

Make the waiting videos (needs `ffmpeg`) and build the coordinator's and the video player's images:

```bash
coordinator/test-deployment/videos/generate.sh
docker build -t coordinator:local coordinator/
docker build -t video-player:local video-player/
```

```bash
cd coordinator/test-deployment
docker compose -f ../../recorder-bot/test-deployment/docker-compose.yml -f ../../recorder-bot/test-deployment/docker-compose.jwt.yml -f docker-compose.yml up -d
```

The two recorder bots (`recorder-bot-1` on port 8090 and `recorder-bot-2` on 8095) and the video player (`video-player-1`) are workers that send heartbeats to the coordinator service through the web server's TLS (ADR 0014); the coordinator service takes the address of their control APIs from the heartbeats. `workers.json` lists their ids and secrets, which are test-only placeholders, never real ones; the coordinator service reads it again whenever it changes, so adding or removing a line needs no restart (edit it in place, as a file mounted into a container does not follow a file that is replaced). `GET /coordinator/workers` lists the workers with their kind, build, capacity, running count and whether they are lost. Without a heartbeat for 15 seconds a worker gets no new work.

On Docker Desktop (Mac, Windows) the recorder bot's host network is the VM's, and `host-gateway` is the machine itself, so the coordinator service cannot reach the bots there. Set `WORKER_ADDRESS` to `<gateway of the recorder-bot-test_meet.jitsi network>` (`docker network inspect recorder-bot-test_meet.jitsi`) before `up`, so that the workers advertise it, and publish the bot ports for the specs on the host, for example with `alpine/socat` containers (the specs' `RECORDER_BOT_*_API_URL` settings).

The specs that need the video player (`waitingVideo`, `staffVideo`) run because `tests.env` sets `VIDEO_PLAYER_AVAILABLE=true`; drop that line to skip them.

Prosody loads `resources/prosody-plugins/mod_coordinator_api.lua`. After a change to it, restart `prosody`, then `jicofo` and `jvb`, which lose their connection when it restarts.

Run the specs from `tests/`, loading the recorder bot's settings and then this one's:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; . ../recorder-bot/test-deployment/tests.jwt.env; . ../coordinator/test-deployment/tests.env; set +a
```

```bash
npm run test-single -- 'specs/coordinator/*.spec.ts'
```

