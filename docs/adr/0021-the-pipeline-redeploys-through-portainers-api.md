---
status: accepted
---

# The pipeline redeploys a stack through Portainer's API, because Portainer CE has no stack webhook

ADR 0017 has the pipeline call each stack's webhook. Production's Portainer is Community Edition, and stack webhooks are a Business Edition feature, so production's stack has none. The pipeline therefore redeploys a stack through Portainer's API instead: it reads the stack and its compose file, and sends them back unchanged with "pull the images again" (`PUT /api/stacks/{id}` with `PullImage`). This is what "Update the stack" with "Re-pull image and redeploy" does in Portainer's editor. Each service then follows its tag again (`production`, ADR 0017).

The pipeline signs in with the access token of a Portainer user of its own, which can update that stack only, not the hospital's other systems or the other stacks. The token is a Protected and Masked CI/CD variable. A stack with a webhook, such as the test stack on Business Edition, can still be redeployed through it; when both are set, the API is used.

## Considered options

- **Upgrade production's Portainer to Business Edition** for its webhooks. This was rejected: it is a licence for one feature, and it changes the production host.
- **Run Portainer's "pull and redeploy" from Git**, a stack deployed from a Git repository. This was rejected: the stack's compose file and environment would come from the repository and the hospital's GitLab, and a change to the repository would redeploy production outside the night window.
- **Call Docker on the production host** through Portainer's proxy, pulling each image and recreating each container. This was rejected: it rebuilds by hand what compose already does, and it needs a token that can reach every container on the host.
- **A webhook of our own** on the production host that runs `docker compose pull && up`. This was rejected: it is one more service to run and secure on production, outside Portainer, which would then no longer know the stack's state.

## Consequences

- Portainer replaces a stack's settings with what an update holds: an update without the environment clears it, and one without the webhook or the auto update turns them off, with no error. This turned the test stack's webhook off once, and the night deployment failed for two weeks before anyone noticed. So the update resends the environment, the webhook and the auto update, and the stack is read again afterwards: if any of them changed, the deployment fails and says so.
- A stack pinned to a commit (`IMAGE_TAG=<commit>`, the README's way to roll back by hand) would be redeployed on the same images and pass every health check without deploying anything. So the production redeploy refuses a stack whose `IMAGE_TAG` is not `production`, before it updates it, and the night pipeline stays failed until the stack follows `production` again.
- The API needs node, and the health checks curl, so the redeploy jobs run in `node:24-bookworm`, which has both.
- The pipeline's runner must reach production's Portainer (port 9443), as it must reach Jicofo's and the videobridge's health checks.
- A stack deployed from Git is refused: it is redeployed through its Git settings.
- The workers' VMs still use webhooks (`WEBHOOK_<ID>`, `deploy/pipeline/deployWorkersMain.ts`); a worker on Portainer CE needs the same API path there.
