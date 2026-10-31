# Record the whole consultation, mark staff visits, keep for three months

A consultation is short (under 30 minutes): the patient stays for the whole call while staff join and leave. The recorder bot records from when the room opens until it closes, rather than only while staff are present, and writes a timeline marking each staff member's joins and leaves, so the evidence also covers what happened between visits. Because the bot itself keeps the conference alive, it stops recording and leaves when no human participant has been present for 60 seconds (to ride out brief reconnects) or immediately when staff end the meeting.

## Consequences

- Video is requested at up to 720p. The resolution actually recorded is whatever each sender can deliver at that moment (camera, CPU, uplink), so evidence quality can drop mid-call when a network degrades.
- Recordings and timelines are kept for three months on file storage the hospital will provide, then deleted. Worst-case size is about 680 MB per 30-minute consultation at 720p (patient and staff video); size the storage as that times consultations per day times 90 days.
