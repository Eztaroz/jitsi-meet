# Token contract for the hospital's token issuer

This is what the system that issues the participants' tokens (the "issuer") must do for this deployment. It replaces the old server's contract, in which the issuer signed HS256 tokens with a secret shared with Prosody (`app_id` `tele-med`, `app_secret`). The new deployment verifies **RS256 tokens with public keys** and has no shared secret with the issuer.

Why the change: the coordinator screen, the staff requests and the satisfaction survey verify the participant's own token themselves, and only with a public key (`coordinator/src/screenAuth.ts` refuses any `alg` but `RS256`). A Prosody virtual host verifies one algorithm, so HS256 and RS256 cannot be mixed for the participants. ADR 0009 (moves) needs the coordinator service to sign tokens that Prosody accepts, which is the same key-server mechanism.

## The token

A JWT signed with RS256 (RSA, at least 2048 bits).

Header:

| Field | Value |
|---|---|
| `alg` | `RS256` |
| `typ` | `JWT` |
| `kid` | The key id of the issuer's signing key: any string, such as `tele-med/key-2026-11`. The public key is published under its SHA-256 (below). |

Payload:

| Claim | Value | Notes |
|---|---|---|
| `iss` | `tele-med` | Must equal `HOSPITAL_JWT_ISSUER` in `.env`. Prosody and the coordinator service refuse any other issuer. |
| `aud` | `jitsi` | Must equal `JWT_AUDIENCE` in `.env`. |
| `sub` | `meet.jitsi` | The XMPP domain of the deployment (docker-jitsi-meet's default `XMPP_DOMAIN`). Prosody does not check it while domain verification is off, which is docker-jitsi-meet's default, but keep it right: it is what the coordinator service puts in its own tokens (`COORDINATOR_TOKEN_SUBJECT`). |
| `exp` | A time, in seconds since the epoch | Required in practice. A patient's token: the length of the visit; staff and coordinators: a working shift at most. The coordinator service refuses an expired token; Prosody does too. |
| `nbf` | Optional | Honoured by the coordinator service and Prosody. |
| `room` | See below | |
| `context.user.id` | A non-empty string | **Required.** A stable identity for the person (an employee id, or the patient's account id). The coordinator service keeps each staff member's station and a move's participant by it. |
| `context.user.name` | A string | Shown on the coordinator's screen and to the people in the room. |
| `context.user.hospital_role` | `patient`, `staff` or `coordinator` | **Required.** The role marker (`PATIENT_MARKER`, `STAFF_MARKER`, `COORDINATOR_MARKER` in `.env`). A token with none of them is a participant of unknown role. |

Do **not** put `moderator`, `affiliation`, `role` or other claims Jitsi reads in `context.user` for a patient. Jicofo makes everyone with a token a moderator, and Prosody (`mod_muc_patient_never_moderator`) takes that away from patients by their marker; a staff member needs no `moderator` claim either.

Other claims (`context.user.email`, `avatar`, `context.group`, `context.features`) are optional and harmless.

## The `room` claim

| Who | `room` |
|---|---|
| A patient | Their own room only: the HN as Prosody names the room, **lower-case and URL-encoded**. A patient's token must not open another patient's room (ADR 0009). |
| Staff | `*`: staff join their station's lounge with a fixed link and are moved to patients' rooms. |
| A coordinator | `*` |

The patient's link is `https://telemedicine.example.org/<HN, URL-encoded>?jwt=<token>`, for example HN `12345/67` is `https://telemedicine.example.org/12345%2F67?jwt=...`. Do not add prejoin settings to the URL hash (recorder-bot/deploy/README.md, "Join links").

Verify the encoding of a room claim with an HN that contains `/` before go-live: the token's `room` must be what Prosody makes of the link (`12345%2f67`).

## Publishing the key

Prosody and the coordinator service fetch the issuer's public key by its `kid`, from a file named `<SHA-256 of the kid, hex>.pem` in the key server (`https://<host>/.well-known/asap/`, served from `keys/asap/` on the deployment host).

On the deployment host, with the issuer's **public** key as a PEM file:

```sh
scripts/publish-issuer-key.sh 'tele-med/key-2026-11' issuer-public.pem
```

It refuses a file with a private key in it and prints the key's fingerprint, to check with the issuer's owner. The private key never leaves the issuer.

Rotating: publish the new key beside the old one, move the issuer to the new `kid`, wait for the old tokens to expire, then delete the old file in `keys/asap/`. Prosody may keep a fetched key for a while: after a rotation, check a new token before deleting the old key.

## Roles of the other issuers

- **The coordinator service** signs the tokens for a move and for the video player itself (`iss` `coordinator`, `kid` `coordinator/key-1`). It is not the issuer's business; Prosody accepts it through the same key server.
- **The recorder bot** signs in with a password to the hidden recorder domain, not with a token.

## Checking a token

A token for a test patient, signed with a key of your own that is published as above:

```js
const jwt = require('jsonwebtoken');
const fs = require('fs');

const token = jwt.sign({
    aud: 'jitsi',
    iss: 'tele-med',
    sub: 'meet.jitsi',
    room: 'test-hn-1',
    context: { user: { id: 'patient-1', name: 'Test Patient', hospital_role: 'patient' } }
}, fs.readFileSync('issuer-private.pem'), { algorithm: 'RS256', keyid: 'tele-med/key-2026-11', expiresIn: '1h' });

console.log(token);
```

Open `https://<host>/test-hn-1?jwt=<token>`. With a staff token (`room: '*'`, `hospital_role: 'staff'`) in a second browser, both reach the same room. Prosody logs the refusal reason of a token it rejects; the coordinator service answers `401`/`403` with an `error` such as `unknown_key`, `wrong_issuer`, `wrong_audience`, `expired`, `bad_signature` or `no_identity`.

## During the move from the old server

The old server verifies HS256 tokens with the shared secret; the new one verifies RS256 only. The issuer must therefore be able to issue either kind and be switched at the cut-over (and switched back to roll back). See [MIGRATION-PLAN.md](MIGRATION-PLAN.md), phases 4 and 5.
