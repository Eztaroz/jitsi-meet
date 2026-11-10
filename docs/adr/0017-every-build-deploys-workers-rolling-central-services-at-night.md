---
status: accepted
---

# Every build deploys to production: workers one at a time, the central services only at night

Every change merged to the main branch on the hospital's GitLab is built into images and deployed to production, with no person in between. A deployment must not cut a consultation, because a consultation is recorded as evidence and can last hours (ADR 0011). So what is deployed decides when:

- **Workers** (ADR 0014) are deployed at any time, **one at a time**. For each worker, the pipeline tells the coordinator service to set it draining, waits until it runs nothing, redeploys its VM, checks that it is healthy, and then sets it back to taking work. This is done only while at least two recorder bots are in service, so that a new consultation always has one; with only one, the recorder bot is deployed in the night window like the central services.
- **The central services** (the front web server, the web server, Prosody, Jicofo, the videobridges and the coordinator service) cut every consultation in progress when they restart. They are deployed only in a **night window, from 22:00 to 05:00**, by a pipeline started at 22:00.

## Considered options

- **Promote by hand** from the test deployment to production. This was rejected: the step would be skipped or forgotten, and the drain and the health checks already stop a bad build at the first worker.
- **Deploy the central services at any time**, with the maintenance page while they restart. This was rejected because a restart ends every consultation in progress, and a patient's room stays open for hours.
- **The hospital's shared Portainer**, which runs the hospital's other systems. This was rejected for a Portainer of the telemedicine service's own, so that the pipeline's access cannot reach other systems.

## Consequences

- This GitLab has no pipeline schedules, so a cron job on one of the telemedicine service's VMs starts the night window's pipeline through GitLab's pipeline trigger. The health checks and the rollback stay in the pipeline, in one place.
- Each image is pushed with two tags: `latest`, which the test deployment follows for end-to-end tests run by hand, and `production`, which production follows. A rollback moves `production` back to the previous build.
- After each step the pipeline checks that the service is healthy. If it is not healthy within 2 minutes, the pipeline rolls that step back and stops. Healthy is what the services report, not a test conference:
  - a worker: its heartbeat reaches the coordinator service with the new build, and its own health check passes;
  - the coordinator service: its health check passes and it holds the database lock (ADR 0015);
  - the web server and the front web server: the page and its configuration are served, not the maintenance page;
  - Prosody, Jicofo and the videobridges: their own health checks pass, and the coordinator service can still list the open rooms.
- The pipeline sets a worker draining through the coordinator service's API, with a secret of its own: not a worker's secret, and not the hospital system's.
- The telemedicine service has its own Portainer, with an agent on each of its VMs (central, recorder bots, video players, videobridges, database). Each VM has one stack, and each stack one webhook, which the pipeline calls.
- A front web server, in the central stack, ends TLS and forwards to the web server. While the web server restarts, it shows the maintenance page. A change to the front web server itself is deployed in the night window too.
- The web client's build needs several gigabytes of memory, so it runs on a runner of its own, not on a host that runs production.
- The repository holds no secrets: they are in the pipeline's variables and in each stack's environment.
