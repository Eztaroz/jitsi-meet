---
status: accepted
---

# A consultation whose recorder bot is lost is taken over by another, with a gap

Extends ADR 0003. When a recorder bot's VM stops sending heartbeats (ADR 0014) while it records, its consultation would otherwise go on unrecorded until it ends, and a consultation can last hours (ADR 0011). So the coordinator service hands that consultation to another recorder bot, which joins the room and records the rest of it. It is the **same consultation**: what was not recorded, from the last heartbeat until the new recorder bot is in the room, is a **gap** in its timeline, as when a recorder bot's browser crashes and is relaunched.

## Considered options

- **No takeover**: tell the staff that the room is no longer recorded. This was rejected because a consultation lasts hours and the patient's room stays open.
- **A new consultation** for the rest of the room. This was rejected because one stretch of a patient's room would then be two consultations, and two evidence recordings, and each would look complete on its own.

## Consequences

- The coordinator service, not the recorder bot, makes a consultation's id, and is the one that decides that a patient's room is being recorded: one consultation per room, whichever worker records it. A takeover gives the same id to the new recorder bot.
- An evidence recording can come from more than one recorder bot. Each writes its part under the consultation's folder in the evidence storage root, so that two parts never overwrite each other.
- The lost VM's part stays in its spool until the VM comes back, and moves to the evidence storage root then; until it does, the evidence recording is incomplete, and says so: the taking-over recorder bot is told which worker it took the consultation from, records that part as awaited, and the consultation's `manifest.json` says `complete: false` with the part in `missingParts` until the part is stored.
- A VM that stopped sending heartbeats but still records (cut off from the coordinator service only) leaves two recorder bots in the room for a while. The overlap is kept, not cut: both parts are evidence. When the cut-off worker reaches the coordinator service again, the answer to its heartbeat tells it that the consultation was taken over, and its recorder bot stops.
- Only a consultation that has not ended is taken over. The coordinator service learns that a consultation ended (nobody joined, everyone left, or it was stopped) from its recorder bot's heartbeat, which lists the consultations it runs, and keeps when it ended. Taking over an ended one would send a recorder bot into an empty room, and take the room a live consultation needs.
- The takeover happens only when another recorder bot has room. If none has, the consultation stays unrecorded from the last heartbeat, and the coordinator service reports it.
