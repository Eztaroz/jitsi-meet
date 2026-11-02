# Coordinator: local test deployment

The recorder bot's JWT test deployment (`recorder-bot/test-deployment`, with `docker-compose.jwt.yml`) plus the coordinator service. Not for production.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret` |
| Coordinator screen | https://localhost:8443/coordinator/screen |
| Coordinator API | https://localhost:8443/coordinator/, bearer secret `coordinator-test-secret` |

The coordinator service publishes no port: it is on the deployment's internal network, and the web server's nginx proxies `/coordinator/` to it (`coordinator/deploy/nginx/coordinator.conf`). Prosody's HTTP port is not published either. The specs reach the service through the proxy.

Follow `recorder-bot/test-deployment/README.md` to build the web bundles and the recorder bot's image and to generate the JWT keys. Generate the coordinator service's own key pair, which Prosody uses to verify the service's calls:

```bash
./keys/generate-keys.sh
```

Then build the coordinator's image and start both:

```bash
docker build -t coordinator:local coordinator/
```

```bash
cd coordinator/test-deployment
docker compose -f ../../recorder-bot/test-deployment/docker-compose.yml -f ../../recorder-bot/test-deployment/docker-compose.jwt.yml -f docker-compose.yml up -d
```

On Docker Desktop (Mac, Windows) the recorder bot's host network is the VM's, and `host-gateway` is the machine itself, so the coordinator service cannot reach the bot there. Set `COORDINATOR_RECORDER_BOT_URL` to `http://<gateway of the recorder-bot-test_meet.jitsi network>:8090` (`docker network inspect recorder-bot-test_meet.jitsi`), and publish the bot ports for the specs on the host, for example with `alpine/socat` containers (the specs' `RECORDER_BOT_*_API_URL` settings).

Prosody loads `resources/prosody-plugins/mod_coordinator_api.lua`. After a change to it, restart `prosody`, then `jicofo` and `jvb`, which lose their connection when it restarts.

Run the specs from `tests/`, loading the recorder bot's settings and then this one's:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; . ../recorder-bot/test-deployment/tests.jwt.env; . ../coordinator/test-deployment/tests.env; set +a
```

```bash
npm run test-single -- 'specs/coordinator/*.spec.ts'
```

All the specs but one run together. `specs/coordinator/moveCapacity.spec.ts` fills the recorder bot to see a move fail when it is at capacity, so run it on its own:

```bash
npm run test-single -- specs/coordinator/moveCapacity.spec.ts
```

`specs/coordinator/movePrepareWait.spec.ts` freezes the browser that the recorder bot launches in its container (`RECORDER_BOT_CONTAINER`) for the move back, so that the bot cannot open the room within this deployment's 15-second prepare wait (`COORDINATOR_PREPARE_WAIT_SECONDS`) while its service still answers (a paused container would make it unreachable instead). Run it on its own too, and not straight after `moveCapacity.spec.ts`: wait until the stations are empty.
