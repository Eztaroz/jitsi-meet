---
status: accepted
---

# A station may serve several stages

Amends ADR 0011 and ADR 0012.

In the telemed postal clinic a nurse sees the patient before the doctor (intake) and after the doctor (aftercare). On some days one nurse does both, on others two nurses share them. With one station per stage, a nurse doing both has to go back and forth between two lounges to call the patients of each stage, and two nurses have to agree each day who takes which. So a station may now serve several stages: in the rooms file it names `stages` instead of `stage`. "Next patient" in its lounge takes the patient who has waited longest in their current stage, across all the station's stages. One nurse, or two, then share one nurse station and its lounge, and nobody decides who takes which stage.

## Rules

- A station with `stage` serves that one stage, as before.
- `examination` is never combined with another stage in one station. Its queue is per doctor (ADR 0012), and a doctor's own queue does not mix with a stage's.
- Two stations may still serve the same stage, as they could before. Both call from that stage's one queue.

## Considered options

- **The stage nearest to done first** (aftercare before intake), so that patients who are nearly done leave sooner. This was rejected because a nurse who is always busy with aftercare would starve intake, which feeds the doctors, who are the clinic's bottleneck. The longest wait is the rule every other queue already follows (ADR 0012).
- **One stage per station, with the nurse switching lounges.** This is what worked before, with no code. It was rejected because the nurse has to watch two queues and walk between two lounges.
- **Refusing a stage that two stations serve.** This was rejected because every build is deployed to production with no person in between (ADR 0017): a new refusal would stop the coordinator service from starting on a rooms file that works today, and sharing a stage does no harm.

## Consequences

- A lounge, and a station as a team on the coordinator's screen, now carry a list of stages (`stages` in `GET /rooms` and on the screen) instead of one `stage`.
