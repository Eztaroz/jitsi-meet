---
status: accepted
---

# Staff call the next patient and change stages themselves

Amends ADR 0008 and ADR 0009.

Under ADR 0011, staff do all the moving, and a coordinator issuing every staff move and stage change would become the bottleneck of the whole clinic. So staff act for themselves. From their station's lounge, a staff member calls the next patient: they are moved into the room of the longest-waiting patient in their station's queue (a doctor's own queue, in examination). From a patient's room, they can change that encounter to any stage, forward or back, except done, and are then moved back to their station's lounge. Done stays with the coordinator and the hospital's system. The coordinator can still move anyone and set any stage.

## Consequences

- A move still goes through the coordinator service and the Prosody module, and is never issued client to client (ADR 0008). The new part is that the coordinator service accepts a request from the staff member being moved. ADR 0009's tokens prove who that staff member is.
- In a patient's own room, staff cannot end the meeting for everyone, kick the patient or demote the patient to a visitor. Each of these would take the patient out of their own room and end its consultation mid-encounter (ADR 0011). Their other moderator actions stay. They can mute the patient and ask them to unmute, but never unmute them: the patient always unmutes themselves, as upstream Jitsi intends.
