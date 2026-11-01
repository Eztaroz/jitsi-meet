# Telemedicine

This fork of Jitsi Meet is used for a hospital's telemedicine service: short video consultations between a patient and hospital staff, recorded as evidence.

## Language

### People

**Patient**:
The person receiving care. They wait, and see the doctor, in their own room, and may be moved to other rooms before and after.
_Avoid_: Client, user, caller

**Staff**:
A hospital employee (doctor, nurse or other) who joins and leaves a consultation to attend to the patient.
_Avoid_: Agent, host, provider

### Consultations

**HN**:
The patient's hospital number, the hospital's identifier for the patient; also the room name.
_Avoid_: Patient ID, MRN

**Room**:
A conference participants meet in: either a patient's own room, named after their HN, or a station.
_Avoid_: Meeting, channel

**Consultation**:
One stretch of a patient's time in one room, recorded as its own evidence recording: in their own room, from when it opens until it closes; in a station, from when the patient arrives until they leave. Typically under 30 minutes.
_Avoid_: Call, session, meeting, visit

**Staff visit**:
One continuous stretch during which a given staff member is present in a consultation.
_Avoid_: Session, attendance

**Verified identity**:
Who a participant is, as the deployment's authentication vouches for it (the token's user id and name), as opposed to the display name the participant typed.
_Avoid_: User, account, login

**Role marker**:
The token claim and value that make a verified identity staff, or the patient.
_Avoid_: Role mapping, rule

### Recording

**Recorder bot**:
The hidden, non-human participant that records every consultation.
_Avoid_: Jibri, recorder, robot

**Evidence recording**:
Everything kept for one consultation: one media file per participant track plus its timeline.
_Avoid_: Video, recording file

**Timeline**:
The time-ordered record of joins, leaves and tracks within a consultation, including each staff visit.
_Avoid_: Log, history

**Evidence storage root**:
The file storage the hospital provides, where evidence recordings are kept, one folder per consultation under the patient's HN.
_Avoid_: Archive, bucket, upload

**Spool**:
The recorder bot service's own local storage, where a consultation is recorded and finalised before its evidence recording moves to the evidence storage root. While the evidence storage root is unavailable, the evidence recording stays there, spooled, and the service retries the move until it succeeds.
_Avoid_: Cache, temp folder

**Retention period**:
How long evidence recordings are kept: three months by default (ADR 0003). The recorder bot service deletes those whose consultation started earlier.
_Avoid_: Expiry, TTL

**Gap**:
A stretch of a consultation the recorder bot did not record, from when its browser crashed or lost its connection until the relaunched bot was back in the room, or the consultation stopped.
_Avoid_: Outage, hole, downtime

### Patient flow

**Encounter**:
One patient's single attendance at the hospital, across rooms and stages, from when it starts until it is done; it holds many consultations.
_Avoid_: Visit, appointment, case

**Stage**:
One step of an encounter, such as seeing the doctor. The patient waits in their own room between stages.
_Avoid_: Step, phase, status

**Queue**:
The patients waiting for one stage, longest-waiting first.
_Avoid_: Waiting list, backlog

**Station**:
A fixed room, belonging to one stage, where staff receive the patients moved in to them, one patient at a time.
_Avoid_: Staff room, desk, booth

### Moves

**Coordinator**:
The hospital person who decides, from one central place, which room each participant should be in.
_Avoid_: Admin, dispatcher, operator

**Move**:
Sending one participant from the room they are in to another room, on a coordinator's or the hospital's system's instruction.
_Avoid_: Transfer, redirect, send to room
