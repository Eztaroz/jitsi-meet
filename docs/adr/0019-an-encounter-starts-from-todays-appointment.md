---
status: accepted
---

# An encounter starts by itself from the patient's appointment today, read from the HIS

A patient waiting in their own room without an encounter is in no queue: staff in a lounge cannot call them (ADR 0012), and a coordinator has to start every encounter by hand. When the HIS is configured, the coordinator service now looks up the **appointments** of each such patient, by HN, for today in its time zone. If the patient has an appointment today that has not had its encounter yet, the service starts one at once, in `waiting`, for the earliest of them. The encounter then follows the clinic whose `hisCodes` include the appointment's clinic code, and the center's pathway when no clinic has that code.

The HIS has no visit number column. An appointment is identified by its row's primary key in `Appoint`: HN, day (`DATE_AP`), clinic code (`CODE_AP`) and doctor code (`C_DOCT`). The encounter keeps `day/clinic/doctor`, such as `2026-11-25/GYN/205`, as its visit number. That key holds no HN, and together with the encounter's HN it names the appointment. It is also how the service knows an appointment has had its encounter. A patient with appointments at two clinics today gets the earliest one's encounter, and the next one's once that encounter is done and the patient waits in the room again (ADR 0013).

The encounter opens when the patient joins their room, not when staff arrive. Recording starts with it, as it did when a coordinator pressed "เริ่ม encounter" while the patient waited (ADR 0003 is unchanged). The time service started is the first time the encounter entered a stage after `waiting`, which its history already has.

## Considered options

- **The hospital's system calls `POST /encounters` with the visit number.** This gives the coordinator service no access to the HIS. It was not chosen because it needs work on the HIS side, while reading the table needs only a read-only user. The route stays.
- **Open the encounter when staff first arrive.** This was rejected because until then the patient is in no queue, so nobody could call them.
- **Read `OPD.Opdq`**, the OPD queue. It has an appointment flag too, but it is the day's queue rather than the appointments, and on the day it was checked it held only one clinic's.

## Consequences

- The service reads the HIS for the first time. It does so read only: the HIS user is given `SELECT` on the appointments table and nothing else. Each connection also sets `SET SESSION TRANSACTION READ ONLY`. The query names its columns, so no name or other detail of the patient is read. Only the active instance reads it, and the HIS is never where the service keeps its state (ADR 0015).
- A patient is looked up when they are seen waiting, and again a minute later at the soonest. So an appointment made at the counter while the patient waits is found within about a minute. A patient who leaves and comes back is looked up at once.
- On the coordinator's screen, a patient's room without an encounter says what the HIS said: no appointment today, every appointment of today already seen, or the HIS could not be read. The coordinator can still start the encounter by hand.
- If the recorder bot cannot take the room, the encounter is not started. The room is looked up again a minute later.
- Without the HIS settings, nothing changes: encounters start only from a coordinator or the hospital's system.
