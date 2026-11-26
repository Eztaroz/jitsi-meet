/**
 * Redeploys a compose stack through Portainer's API (ADR 0021). Portainer CE, which runs production, has no stack
 * webhook, so the pipeline does what the editor's "Update the stack" with "Re-pull image and redeploy" does: it reads the
 * stack and its compose file, and sends them back unchanged with `PullImage`, so that every service follows the tag its
 * image names again (ADR 0017: `production`).
 *
 * Portainer replaces a stack's settings with what the update holds: an update without the environment clears it, and one
 * without the webhook or the auto update turns them off, with no error. So the update resends all three, and the stack is
 * read again afterwards to check that none of them changed.
 */

/** A deployment that stopped: the message says why. It never holds the token or a value of the stack's environment. */
export class RedeployError extends Error {}

interface IPair {
    name: string;
    value: string;
}

/** What this script reads of `GET /api/stacks/{id}`. */
interface IStack {
    AutoUpdate?: { Webhook?: string; } | null;
    EndpointId: number;
    Env?: IPair[] | null;
    GitConfig?: unknown;
    Name?: string;
    Webhook?: string;
}

export interface IRedeployOptions {

    /** Portainer's address, e.g. https://<host>:9443. */
    baseUrl: string;

    /**
     * The tag the stack's images must follow (its `IMAGE_TAG`): a stack pinned to another tag would be redeployed on the
     * same images, and the deployment would pass without deploying anything.
     */
    imageTag?: string;
    log?: (message: string) => void;
    stackId: number;

    /** How long Portainer may take to pull the images and recreate the containers, in milliseconds: 10 minutes. */
    timeoutMs?: number;

    /** A Portainer access token, of a user who can update this stack only. */
    token: string;
}

const MAX_DETAIL = 500;

/**
 * The webhook a stack has, wherever this Portainer keeps it.
 *
 * @param {IStack} stack - The stack.
 * @returns {string}
 */
function webhookOf(stack: IStack): string {
    return stack.Webhook || stack.AutoUpdate?.Webhook || '';
}

/**
 * The environment, in an order that does not depend on Portainer's.
 *
 * @param {IStack} stack - The stack.
 * @returns {string}
 */
function envOf(stack: IStack): string {
    return JSON.stringify((stack.Env ?? []).map(({ name, value }) => [ name, value ]).sort());
}

/**
 * Redeploys the stack on its current compose file and environment, pulling its images again.
 *
 * @param {IRedeployOptions} options - Which stack, on which Portainer.
 * @throws {RedeployError} When Portainer refuses, or the stack is not one this script may redeploy.
 * @returns {Promise<void>}
 */
export async function redeployStack(options: IRedeployOptions): Promise<void> {
    const log = options.log ?? (() => undefined);
    const base = options.baseUrl.replace(/\/+$/u, '');
    const id = options.stackId;

    const call = async <T>(path: string, init: RequestInit = {}, timeoutMs = 30_000): Promise<T> => {
        const method = init.method ?? 'GET';
        let response: Response;

        try {
            response = await fetch(`${base}${path}`, {
                ...init,
                headers: { 'content-type': 'application/json', 'x-api-key': options.token },
                signal: AbortSignal.timeout(timeoutMs)
            });
        } catch (error) {
            throw new RedeployError(`Portainer did not answer ${method} ${path}: ${(error as Error).message}`);
        }

        if (!response.ok) {
            // Portainer says why in { message, details }; compose's own error is in details.
            const text = (await response.text().catch(() => '')).slice(0, MAX_DETAIL);

            throw new RedeployError(`Portainer refused ${method} ${path} (HTTP ${response.status})${text ? `: ${text}` : ''}`);
        }

        return await response.json() as T;
    };

    const stack = await call<IStack>(`/api/stacks/${id}`);

    if (stack.GitConfig) {
        throw new RedeployError(`stack ${id} is deployed from Git: redeploy it through its Git settings, not this script`);
    }

    const tag = stack.Env?.find(pair => pair.name === 'IMAGE_TAG')?.value ?? '';

    if (options.imageTag && tag !== options.imageTag) {
        throw new RedeployError(`stack ${id} follows IMAGE_TAG "${tag || '(not set)'}", not "${options.imageTag}": `
            + `it is pinned, so a redeploy would deploy nothing. Set IMAGE_TAG=${options.imageTag} in the stack's environment`);
    }

    const { StackFileContent } = await call<{ StackFileContent: string; }>(`/api/stacks/${id}/file`);

    log(`Updating stack ${id} (${stack.Name ?? 'unnamed'}) on environment ${stack.EndpointId}: same compose file, `
        + `${stack.Env?.length ?? 0} variables, images pulled again`);
    await call(`/api/stacks/${id}?endpointId=${stack.EndpointId}`, {
        body: JSON.stringify({
            Env: stack.Env ?? [],
            Prune: false,
            PullImage: true,
            StackFileContent,
            ...stack.AutoUpdate ? { AutoUpdate: stack.AutoUpdate } : {},
            ...stack.Webhook ? { Webhook: stack.Webhook } : {}
        }),
        method: 'PUT'
    }, options.timeoutMs ?? 600_000);

    const after = await call<IStack>(`/api/stacks/${id}`);

    if (envOf(after) !== envOf(stack)) {
        throw new RedeployError(`stack ${id} was redeployed, but its environment changed: check it in Portainer`);
    }
    if (webhookOf(after) !== webhookOf(stack)) {
        throw new RedeployError(`stack ${id} was redeployed, but Portainer turned its webhook off: turn it on again`);
    }
    log(`Stack ${id} redeployed; its environment${webhookOf(stack) ? ' and its webhook' : ''} kept`);
}
