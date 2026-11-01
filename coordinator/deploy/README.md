# Coordinator service: operator guide

The coordinator service owns encounters, stages and queues, and moves participants between rooms (`GLOSSARY.md`, ADR 0008). This guide covers what exists so far: starting an encounter. The hospital's system calls the service instead of the recorder bot; the service asks the recorder bot to record the patient's room.

It is for the hospital's internal network only. Never expose its port to the internet.

## Settings

| Variable | Meaning |
|---|---|
| `COORDINATOR_API_SECRET` (required) | The bearer secret the hospital's system sends. Treat it like a password. |
| `COORDINATOR_RECORDER_BOT_URL` (required) | The recorder bot service's base URL. |
| `COORDINATOR_RECORDER_BOT_SECRET` (required) | The recorder bot service's `RECORDER_BOT_API_SECRET`. |
| `COORDINATOR_API_PORT` | The port the API listens on. Default 8091. |
| `COORDINATOR_DATA_DIR` | Where the database is. Default `/var/lib/coordinator`; mount a volume there. |

## Running it

```bash
docker build -t coordinator:local coordinator/
```

Run it with the settings above and a volume at `/var/lib/coordinator`. Without the volume, encounters are lost when the container is replaced.

## API

Every request carries `Authorization: Bearer <COORDINATOR_API_SECRET>`.

| Request | Answer |
|---|---|
| `POST /encounters` with `{"hn": "..."}` | `201` and the encounter `{id, stage, startedAt}`, with stage `waiting`, after the recorder bot accepted the patient's room. If the HN already has an open encounter: `200` and that encounter, and the recorder bot is asked nothing. `503` if the recorder bot is at capacity or unreachable; nothing is saved then, so the call can be repeated. |
| `GET /encounters/<id>` | The encounter, with its `hn`. `404` if there is none. |
| `GET /health` | `200` and the number of open encounters. |

Encounters are identified by an opaque id. The HN appears only in the body that starts an encounter and in what `GET /encounters/<id>` returns, never in a path or in the service's logs (ADR 0005).
