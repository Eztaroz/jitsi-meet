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
A conference participants meet in: either a patient's own room, named after their HN, or a lounge.
_Avoid_: Meeting, channel

**Consultation**:
One stretch of a patient's own room, from when it opens until it closes, recorded as its own evidence recording. The patient never leaves their own room during an encounter, so a consultation usually spans the whole encounter and can last hours.
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

**Review file**:
One video file of a whole consultation, showing every participant side by side with their audio mixed, made from an evidence recording so that a person can watch it. It is not evidence, and it can always be made again.
_Avoid_: Merged recording, Evidence file, Composite

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
One patient's attendance at one clinic on one day, through the stages of its pathway, from when it starts until a coordinator or the hospital's system marks it done; staff can change its stage, but not to done. It usually holds one consultation; more when the patient's own room closed and opened again. A patient seen at two clinics in a day has two encounters, sharing one visit number.
_Avoid_: Visit, appointment, case

**Visit number**:
The hospital system's number for a patient's attendance on one day (VN). Each encounter carries it, and several encounters can share one.
_Avoid_: Visit ID, encounter ID

**Center**:
A part of the hospital with its own staff, stations and coordinator, holding several clinics.
_Avoid_: Department, unit, site

**Clinic**:
A specialty service within a center that a patient attends, such as Tele internal medicine or Tele gynaecology.
_Avoid_: Department, specialty, OPD

**Pathway**:
The stages an encounter goes through, in order, from waiting to done: its clinic's own, else its center's, else the deployment's default.
_Avoid_: Flow, journey, workflow

**Stage**:
One step of an encounter's pathway. The default pathway is waiting, registration, intake, examination, aftercare, billing, pharmacy, then done. Every stage happens in the patient's own room: staff come to the patient, never the other way round.
_Avoid_: Step, phase, status, pre-consultation, post-consultation

**Registration**:
The first stage after waiting, in which a nurse registers the patient for the visit.
_Avoid_: Check-in, sign-up

**Intake**:
The stage before the doctor, in which a nurse takes the patient's history and the patient is given a doctor.
_Avoid_: Pre-consultation, triage, history taking

**Examination**:
The stage in which the doctor sees the patient, in the patient's own room.
_Avoid_: Consultation, doctor visit

**Aftercare**:
The stage after the doctor, in which a nurse goes through the appointments the doctor made, further instructions and costs.
_Avoid_: Post-consultation, discharge

**Billing**:
The stage in which finance staff settle what the patient pays, including their benefits.
_Avoid_: Payment, cashier

**Pharmacy**:
The last stage before done, in which a pharmacist goes through the patient's medicines with them.
_Avoid_: Dispensary, drug counter

**Health questionnaire**:
Short questions about the patient's health or visit, two answer choices each, that a patient answers alone in their own room, in place of measured vital signs among others. The deployment offers several; staff or a coordinator send one at any stage. The answers belong to the encounter, for the staff who see the patient; an unanswered one holds nobody up.
_Avoid_: Pre-visit questionnaire, vital signs, triage form, screening, satisfaction survey

**Waiting video**:
A medical-education video the hospital provides and the deployment hosts, played into a waiting patient's own room as part of the conference, so the evidence recording holds it; the patient cannot stop it. Each stage has a default one, and a patient can be given another.
_Avoid_: Advert, clip, YouTube video

**Video player**:
The visible, non-human participant that plays a waiting video into a patient's own room.
_Avoid_: Media bot, video bot, recorder bot

**Queue**:
The patients waiting for one stage, longest-waiting first; in examination, the patients waiting for one doctor. It is all a patient's waiting room is: they wait in their own room.
_Avoid_: Waiting list, backlog, virtual waiting room

**Station**:
A center's team of staff for one stage, who serve that stage's patients one at a time by joining each patient's own room. It is not a room; its staff wait in its lounge.
_Avoid_: Staff room, desk, booth, service point

**Lounge**:
A fixed room belonging to one station, where that station's staff wait between patients; being in it is what makes a staff member free at that station. No patient is ever in it, so nothing in it is recorded.
_Avoid_: Break room, home room

**Satisfaction survey**:
What a patient answers, if they choose to, about a video call on the page they land on once they have left a room: an overall rating, what stood out, a rating of each part of the service and suggestions. It is kept with the patient's HN, for the hospital's quality department.
_Avoid_: Feedback, review, rating

### Moves

**Coordinator**:
The hospital person who decides, from one central place, which room each participant should be in.
_Avoid_: Admin, dispatcher, operator

**Move**:
Sending one staff member from the room they are in to another room, on a coordinator's or the hospital's system's instruction, or their own when they call the next patient or finish with one. Patients are never moved.
_Avoid_: Transfer, redirect, send to room
