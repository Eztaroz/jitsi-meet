# Coordinator: local test deployment

The recorder bot's JWT test deployment (`recorder-bot/test-deployment`, with `docker-compose.jwt.yml`) plus the coordinator service. Not for production.

| Service | Where |
|---|---|
| Jitsi web | https://localhost:8443 |
| Recorder bot control API | http://localhost:8090, bearer secret `recorder-bot-test-secret` |
| Coordinator API | http://localhost:8094, bearer secret `coordinator-test-secret` |

Follow `recorder-bot/test-deployment/README.md` to build the web bundles and the recorder bot's image and to generate the JWT keys. Then build the coordinator's image and start both:

```bash
docker build -t coordinator:local coordinator/
```

```bash
cd coordinator/test-deployment
docker compose -f ../../recorder-bot/test-deployment/docker-compose.yml -f ../../recorder-bot/test-deployment/docker-compose.jwt.yml -f docker-compose.yml up -d
```

Run the specs from `tests/`, loading the recorder bot's settings and then this one's:

```bash
set -a; . ../recorder-bot/test-deployment/tests.env; . ../recorder-bot/test-deployment/tests.jwt.env; . ../coordinator/test-deployment/tests.env; set +a
```

```bash
npm run test-single -- 'specs/coordinator/*.spec.ts'
```
