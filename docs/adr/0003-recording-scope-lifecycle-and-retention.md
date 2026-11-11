# Record the whole consultation, mark staff visits, keep for three months

Extended by ADR 0006 for stations, which ADR 0011 superseded: a consultation now usually spans a whole encounter and can last hours, so read the size estimate below per encounter, not per 30 minutes.

A consultation is short (under 30 minutes): the patient stays for the whole call while staff join and leave. The recorder bot records from when the room opens until it closes, rather than only while staff are present, and writes a timeline marking each staff member's joins and leaves, so the evidence also covers what happened between visits. Because the bot itself keeps the conference alive, it stops recording and leaves when no human participant has been present for 60 seconds (to ride out brief reconnects) or immediately when staff end the meeting.

## Consequences

- Video is requested at up to 720p. The resolution actually recorded is whatever each sender can deliver at that moment (camera, CPU, uplink), so evidence quality can drop mid-call when a network degrades.
- Recordings and timelines are kept for three months on file storage the hospital will provide, then deleted. The recorder bot copies each video track as the sender encoded it (ADR 0014), so the size follows the sender's bitrate, which is no longer capped at 1.5 Mbps. A camera sends about 1 Mbps for AV1 at 720p; VP9 and VP8 cost more for the same picture, and a shared screen costs more than a camera. Size the storage per video participant as the bitrate in Mbps times 450 MB per hour, plus about 15 MB per hour for each audio track. For a patient and one staff member on AV1 cameras that is about 0.5 GB per 30 minutes (the earlier figure of 680 MB assumed the 1.5 Mbps cap); plan on more when a screen is shared for long. Then multiply by the consultations per day and 90 days. These figures come from the sender's bitrate, not a measured consultation: check them against the measurement in `recorder-bot/deploy/README.md` (Capacity).
