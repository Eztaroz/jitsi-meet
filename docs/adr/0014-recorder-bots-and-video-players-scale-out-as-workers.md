---
status: accepted
---

# Recorder bots and video players scale out as workers that send heartbeats to the coordinator service

Each consultation needs its own recorder bot, and each waiting video its own video player: both are a headless Chromium in the room, and a host runs only a few of them. One host for everything will not be enough as more clinics come on, so the recorder bot service and the video player service run as **workers**, each on its own VM, the way extra videobridges join Jitsi's brewery. A worker sends a **heartbeat** to the coordinator service every few seconds with its kind, its address, how many it can run and how many it runs now. The coordinator service keeps the workers it has heard from recently and hands each new consultation, or waiting video, to the worker of that kind with the most room. A worker that is **draining** runs what it has to the end but gets nothing new, so that a VM can be updated or shut down without cutting a consultation.

## Considered options

- **A fixed list of workers in the coordinator service's configuration.** This was rejected as the end state, because adding or removing a VM would need a change and a restart of the central service. It is the first step, before heartbeats.
- **Workers ask the coordinator service for work (pull).** No port would be open on a worker's VM. This was rejected because both services' control APIs would have to be turned around, while with heartbeats they stay as they are.
- **A load balancer in front of the workers.** This was rejected because the coordinator service must know which video player plays in which room, to stop it, and must notice a lost recorder bot to take its consultation over (ADR 0016).

## Consequences

- The list of workers is not stored: after the coordinator service restarts, it is whole again within one heartbeat period. Which worker plays a waiting video in which room is rebuilt from the video players' health reports.
- A worker sends a heartbeat every 5 seconds and is lost after 15 seconds without one. The heartbeat also says which build the worker runs, so that a deployment can see the new build come up (ADR 0017).
- A new consultation, or waiting video, is refused as at capacity only when no worker of its kind has room. A worker that answers that it is full, or does not answer, is skipped for the next one.
- Each worker has its own secret, both to send heartbeats and to be given work, because the coordinator service sends patients' HNs to it: a host that could pretend to be a worker would receive them. The coordinator service keeps a list of worker ids and their secrets, which it reads again without a restart: adding a VM adds a line, and removing a line shuts a worker out at once.
- Heartbeats reach the coordinator service through the web server's TLS, like everything else (ADR 0008). The coordinator service reaches a worker's control API over plain HTTP on a separate internal network (VLAN), whose firewall lets only the central VM in. Until that network exists, each worker VM's own firewall lets only the central VM reach its control API.
- Every recorder bot writes to the same evidence storage root, on shared storage (NFS), and keeps its own spool on its own VM. Only one of them sweeps the evidence storage root at a time, so that two sweeps do not delete the same folder: the coordinator service names that one in its answer to the heartbeats.
- A lost video player's waiting video is not taken over: it stops, and staff can play it again. Waiting videos are not evidence, and may later be played by the web client itself.
