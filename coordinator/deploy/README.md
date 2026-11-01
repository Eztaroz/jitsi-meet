# Coordinator service: operator guide

The coordinator service owns encounters, stages and queues, and moves participants between rooms (`GLOSSARY.md`, ADR 0008). This guide covers what exists so far: starting an encounter, listing the open rooms with who is in them, moving a staff member to another open room, and the participant cancelling it. The hospital's system calls the service instead of the recorder bot; the service asks the recorder bot to record the patient's room.

It is for the hospital's internal network only. Never expose its port to the internet.

## Settings

| Variable | Meaning |
|---|---|
| `COORDINATOR_API_SECRET` (required) | The bearer secret the hospital's system sends. Treat it like a password. |
| `COORDINATOR_RECORDER_BOT_URL` (required) | The recorder bot service's base URL. |
| `COORDINATOR_RECORDER_BOT_SECRET` (required) | The recorder bot service's `RECORDER_BOT_API_SECRET`. |
| `COORDINATOR_PROSODY_URL` (required) | Prosody's HTTP base URL, where the coordinator API module listens (below). |
| `COORDINATOR_SIGNING_KID` (required) | The service's key id. |
| `COORDINATOR_SIGNING_KEY_FILE` (required) | The PEM private key file. Prosody must have the public key (below). Keep it like the hospital issuer's key: whoever holds it can call Prosody's coordinator API. |
| `COORDINATOR_PATIENT_MARKER`, `COORDINATOR_STAFF_MARKER` | The token claims that mark a verified identity as a patient or as staff, written `user.<claim>=<value>` or `group=<value>`, like the recorder bot's. With none, every occupant's role is `unknown`. |
| `COORDINATOR_TOKEN_SUBJECT` (required) | The `sub` claim of the tokens the service issues for a move, as your participants' tokens have it (the XMPP domain). |
| `COORDINATOR_TOKEN_ISSUER`, `COORDINATOR_TOKEN_AUDIENCE` | The `iss` and `aud` of those tokens. Defaults `coordinator` and `jitsi`. Prosody must accept them (below). |
| `COORDINATOR_API_PORT` | The port the API listens on. Default 8091. |
| `COORDINATOR_DATA_DIR` | Where the database is. Default `/var/lib/coordinator`; mount a volume there. |

## Running it

```bash
docker build -t coordinator:local coordinator/
```

Run it with the settings above and a volume at `/var/lib/coordinator`. Without the volume, encounters are lost when the container is replaced.

## Prosody

The service reads the open rooms from a Prosody module, `resources/prosody-plugins/mod_coordinator_api.lua`. On docker-jitsi-meet:

1. Mount the file into the `prosody` container at `/prosody-plugins-custom/mod_coordinator_api.lua`, and add `coordinator_api` to `XMPP_MODULES` (comma-separated, with `presence_identity`, which the identities need).
2. Serve the service's public key where Prosody can fetch it: `<URL>/<sha256 of the key id>.pem` (for example `printf %s "$KID" | sha256sum`). Set `XMPP_CONFIGURATION` to `coordinator_api_key_server = "<URL>"`. This is not the key server of the participants' tokens: the module accepts only tokens issued by `coordinator` for the audience `coordinator`, and only keys from this one.
3. Make Prosody's HTTP port (5280) reachable by the coordinator service, and by nothing else. The module's endpoint lists everyone in every room.

`coordinator/test-deployment/docker-compose.yml` does all of this for the test deployment.

### Tokens for a move

A move sends the participant to another room with a token the service signs: it names the destination room only, carries the participant's own verified identity and role claim, and lasts five minutes (ADR 0009). Prosody must therefore accept it as a participant token:

- add the issuer (`coordinator`) to the accepted issuers (`JWT_ACCEPTED_ISSUERS` on docker-jitsi-meet), and the audience if you changed it;
- serve the service's public key from the key server of your participants' tokens (`JWT_ASAP_KEYSERVER`), at `<URL>/<sha256 of the key id>.pem`. A key server has one set of accepted issuers, so anyone who can write to it can add keys that sign tokens for any room: protect it.

Mind the room claim: it is the room name as Prosody names it, lower-case and URL-encoded.

## API

Every request carries `Authorization: Bearer <COORDINATOR_API_SECRET>`.

| Request | Answer |
|---|---|
| `POST /encounters` with `{"hn": "..."}` | `201` and the encounter `{id, stage, startedAt}`, with stage `waiting`, after the recorder bot accepted the patient's room. If the HN already has an open encounter: `200` and that encounter, and the recorder bot is asked nothing. `503` if the recorder bot is at capacity or unreachable; nothing is saved then, so the call can be repeated. |
| `GET /encounters/<id>` | The encounter, with its `hn`. `404` if there is none. |
| `GET /rooms` | `200` and `{rooms: [{name, occupants: [{endpointId, displayName, role, identity}]}]}`: the open rooms, a patient's room named by the HN. `role` is `patient` or `staff` by the role markers, `hidden` for the recorder bot and other hidden participants, else `unknown`; `identity` is the verified `{id, name}` when the deployment verifies identities. `503` if Prosody cannot be asked. |
| `POST /moves` with `{"from": {"room": "...", "endpointId": "..."}, "to": {"room": "..."}}` | Moves the participant `endpointId` from the open room `from.room` to the open room `to.room`, both as `GET /rooms` names them. Only staff can be moved so far. `202` and `{id, state: "counting_down"}`: the participant's page counts down five seconds, then enters the destination with a token for it. Or `200` and `{id, state: "refused", reason}`: `participant_not_found`, `participant_not_movable` (hidden), `only_staff_can_be_moved`, `destination_not_open`, `already_being_moved` (the participant's earlier move is still under way). `503` if Prosody cannot be asked. |
| `GET /moves/<id>` | `{id, state, reason}`: `counting_down`, `done` (the same verified identity is in the destination), `cancelled` (the participant pressed "Stay here" during the countdown) or `failed` (`participant_did_not_arrive`, 30 seconds after the countdown). |
| `GET /health` | `200` and the number of open encounters. |

Encounters are identified by an opaque id. The HN appears only in the body that starts an encounter and in what `GET /encounters/<id>` returns, never in a path or in the service's logs (ADR 0005).
