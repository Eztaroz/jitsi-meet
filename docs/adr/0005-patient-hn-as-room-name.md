# Name each room after the patient's hospital number

The hospital system already creates rooms from the patient's hospital number (HN), so the room name is the HN rather than an opaque id mapped by the hospital system. We accept that the room name, and therefore the HN, appears in the invite URL, the BOSH/WebSocket `room` query parameter, nginx access logs, Prosody, Jicofo and JVB logs, rtcstats identity and the JWT `room` claim (see `doc/recorder-bot-research.md`).

## Consequences

- Those logs contain patient identifiers and must be access-controlled and retention-limited like other patient data.
- A patient's consultations all reuse the same room name, so recordings must be keyed by HN plus start time, never by room name alone.
