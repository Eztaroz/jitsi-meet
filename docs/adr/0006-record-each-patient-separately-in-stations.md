# Record each patient separately in a station

Stations are fixed staff rooms that many patients pass through in a day, one at a time. Recording a station as one long recording, the way ADR 0003 records a patient's own room, would mix several patients' evidence in one file kept under no single HN. Instead, each patient moved into a station starts a consultation of their own, which stops when that patient leaves, and its evidence recording is kept under that patient's HN like any other consultation.

## Consequences

- The recorder bot gets a second stop rule: in a station, a consultation stops when its patient leaves, even though the staff stay; the 60-second rule of ADR 0003 still applies to a patient's own room.
- The station's room name says nothing about the patient, so the service that moves the patient in has to tell the recorder bot whose consultation it is.
- A patient's evidence for one encounter is spread over several consultations (their own room and each station), all under their HN, ordered by start time.
- A patient's own room usually closes under the 60-second rule while they are in a station. Moving them back opens it again as a new consultation, so leaving for a station and coming back splits the own-room evidence into two consultations.
- The recorder bot waits for a station's patient longer than the coordinator service waits for them to arrive. Normally the coordinator service gives up first and has the consultation discarded; the recorder bot's own wait only matters if the coordinator service is down.
