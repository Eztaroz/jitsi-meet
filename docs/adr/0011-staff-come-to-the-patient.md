---
status: accepted
---

# Staff come to the patient; a station is a team, not a room

Supersedes ADR 0006.

Moving patients into station rooms split a patient's evidence over several consultations (their own room, then each station), and made the patient's client leave and rejoin a conference at every stage. Patients are on their own devices and are the least able to recover from a failed move. Instead, every stage now happens in the patient's own room, the way examination already did: the patient never moves during an encounter, and staff move into the patient's room and back out. A station is no longer a room. It is a stage's team of staff, and each station has a lounge of its own: a staff member in a station's lounge is free at that station, and a staff member in a patient's room is serving that patient's current stage. The coordinator's screen shows each patient as "at" a station when that station's staff are in their room.

## Considered options

- **Keep station rooms** (ADR 0006): a fixed room per station, with patients moved in and out. This was rejected because of the split evidence and the patient moves.
- **Mixed**: station rooms for some stages and staff visits for others. This was rejected because it means two ways to do the same thing in the rules, the screen and the recorder bot.
- **Station membership in the token** (a role marker per station), or **set on the coordinator's screen each day**. These were rejected in favour of a lounge per station, which needs no new data and lets staff change station during the day by changing lounge.

## Consequences

- A consultation usually spans the whole encounter and can last hours, so ADR 0003's per-consultation size estimate becomes a per-encounter one. The total recorded time hardly changes, because the patient's waits in their own room were already recorded. The difference is fewer, longer files.
- ADR 0006's second stop rule (a station consultation stops when its patient leaves) and the coordinator telling the recorder bot whose station consultation it is both go. The 60-second rule of ADR 0003 is the only stop rule.
- Patients are never moved. A move is now always a staff member's: into a patient's room, or back to a lounge.
- A staff member who ends the meeting for everyone would end the patient's room and its consultation mid-encounter.
