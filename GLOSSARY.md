# Telemedicine

This fork of Jitsi Meet is used for a hospital's telemedicine service: short video consultations between a patient and hospital staff, recorded as evidence.

## Language

### People

**Patient**:
The person receiving care, who stays in the consultation from start to end.
_Avoid_: Client, user, caller

**Staff**:
A hospital employee (doctor, nurse or other) who joins and leaves a consultation to attend to the patient.
_Avoid_: Agent, host, provider

### Consultations

**HN**:
The patient's hospital number, the hospital's identifier for the patient; also the room name.
_Avoid_: Patient ID, MRN

**Room**:
The conference named after a patient's HN; every consultation for that patient takes place in it.
_Avoid_: Meeting, channel

**Consultation**:
One occurrence of a patient's room being open, from when it opens until it closes; typically under 30 minutes.
_Avoid_: Call, session, meeting, visit

**Staff visit**:
One continuous stretch during which a given staff member is present in a consultation.
_Avoid_: Session, attendance

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
The recorder bot service's own local storage, where a consultation is recorded and finalised before its evidence recording moves to the evidence storage root.
_Avoid_: Cache, temp folder
