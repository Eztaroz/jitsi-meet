# Name each room after the patient's hospital number

The hospital system already creates rooms from the patient's hospital number (HN), so the room name is the HN rather than an opaque id mapped by the hospital system. We accept that the room name, and therefore the HN, appears in the invite URL, the BOSH/WebSocket `room` query parameter, nginx access logs, Prosody, Jicofo and JVB logs, rtcstats identity and the JWT `room` claim (see `doc/recorder-bot-research.md`).

## Consequences

- Those logs contain patient identifiers and must be access-controlled and retention-limited like other patient data.
- A patient's consultations all reuse the same room name, so recordings must be keyed by HN plus start time, never by room name alone.
- An HN can contain `/`, which the room name encodes as `%2F`. nginx decodes it before it picks a location, so stock Jitsi nginx configuration reads the patient's link as a room under a tenant. Deployments include `recorder-bot/deploy/nginx/hn-rooms.conf` to keep the link in one room. The fork also names the room in the XMPP websocket's `room` parameter as the room's JID does: upstream decodes it, so Prosody finds no room for such a name, and "End meeting for all" does nothing there.
- A patient is moved only into a station or into their own room, never into a room named after another HN, open or closed, so their evidence is never kept under another patient's HN. A patient whose own room the coordinator service has not yet seen them in can be moved only into a station.
