---
status: accepted
---

# An NHSO bypass day covers the whole day, and an encounter's NHSO authentication is for the claim, not for care

Before a call, the patient authenticates in the NHSO (National Health Security Office) app, so that the hospital can claim the visit. NHSO's API says whether a patient has done it, and it is often down. On a day it is down, NHSO does not check: every visit of the day is claimed as authenticated.

So a coordinator can **declare a bypass day** from the coordinator's screen: "the NHSO API is down today". It covers the whole day in `COORDINATOR_TIME_ZONE`, from midnight to midnight, the encounters that started before it was declared and after, not one patient. It is kept by day in the coordinator service's database, with who declared it and when, and every declaring is in the audit log. An encounter is **of a bypass day** when it started on that day; that is worked out from the day's record and the encounter's start, not stored on the encounter. The claims staff list the encounters of the bypass days of a period as CSV, like the satisfaction survey report.

An encounter's **NHSO authentication** is shown on the coordinator's screen: authenticated, not yet, cannot be checked, or bypassed. It **never holds an encounter up**: a patient who has not authenticated moves through every stage, and the intake nurse can ask them to do it while they wait.

## Considered options

- **A bypass per encounter**, which a coordinator ticks for each patient. This was rejected: NHSO's rule is about the day, and on a bad day a coordinator would have to tick every patient, while the patients who came before the API went down would be missed.
- **Store `bypassed` on each encounter**, at the declaring and at each start after it. This was rejected: a cancelled declaring would have to be undone on every encounter, and the claims list would depend on that being right. A day's record, and the encounter's start, already say it.
- **Hold the encounter until the patient has authenticated.** This was rejected: the status is for the claim, and a patient must not wait for care because a government API is slow or down.

## Consequences

- A bypass day can be **cancelled the same day only**, when it was declared by mistake. The cancelling is kept with the day (`cancelledAt`, `cancelledBy`) and audited; a cancelled day is no bypass day, and may be declared again. A past day cannot be declared or cancelled: the claim of that day may already be sent.
- The audit log has `kind: "nhso_bypass"`, with `action` `declare` or `cancel`, the `day`, the `issuer`, and `outcome` `ok` or `refused` with a `reason` (`already_declared`, `no_bypass_today`). Each export of the list is `kind: "nhso_bypass_export"` with the `count` of encounters and the period's first `day` and `lastDay`.
- Bypass days are deleted after `COORDINATOR_RETENTION_DAYS`, as encounters are: the list can only name encounters the service still keeps.
- The NHSO API's spec has not arrived. The service takes an NHSO checker, which says whether an encounter's patient has authenticated or throws when the API cannot be asked, but none is configured yet: until one is, every status that is not bypassed is "cannot be checked". The statuses are held in memory and asked again after a restart; while the API is down they say "cannot be checked", and they are asked again when it answers. Its credentials will live in the CI/CD variables and the stack's environment, never in the repository.
