---
status: accepted
---

# Stages come from pathways in configuration, and an encounter belongs to one clinic

Different clinics will take patients through different stages: one clinic may have no pharmacy, another no billing. Stages are therefore not written into the code. The deployment's configuration holds **pathways**, ordered lists of stages, and an encounter follows its clinic's pathway, else its center's, else the default one. Only three stages mean something to the code: waiting comes first, done comes last, and examination has a queue per doctor and needs a doctor. Every other stage is just a name, a station and a default waiting video. Because a pathway belongs to a clinic, an encounter is a patient's attendance at **one clinic**, and not a whole hospital visit. A patient seen at two clinics in a day has two encounters, which share the hospital's visit number.

## Considered options

- **Stages in the code**, as before. This was rejected because every clinic's difference would need a code change and a deploy.
- **One encounter per visit number.** This was rejected because a patient seen at two clinics in a day could then follow only one pathway.

## Consequences

- For now there is one center, no clinics and only the default pathway. The configuration is shaped as center → clinic → pathway, with stations and lounges under their center, so that adding centers and clinics later changes no format. Centers and clinics will come from the hospital's system when it starts an encounter, once its appointments are connected.
- The coordinator service refuses to start with a configuration that removes a stage that still holds open encounters, and says which stage holds how many. Past stages keep their ids in an encounter's history, and are shown by id once their name is gone.
- Later, a coordinator sees only their own center.
