# Coordinator: local test deployment

The recorder bot's JWT test deployment (`recorder-bot/test-deployment`, with `docker-compose.jwt.yml`) plus the coordinator service. Not for production.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret` |
| Prosody's HTTP port, for the coordinator service only (localhost) | http://localhost:5280 |
| Coordinator API | http://localhost:8094, bearer secret `coordinator-test-secret` |

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

`specs/coordinator/movePrepareWait.spec.ts` pauses the recorder bot's container (`RECORDER_BOT_CONTAINER`) so that it cannot open a room within this deployment's 15-second prepare wait (`COORDINATOR_PREPARE_WAIT_SECONDS`), so run it on its own too.
