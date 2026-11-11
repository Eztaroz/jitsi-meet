/**
 * Deploys a build to the workers (recorder bots and video players) one at a time, without cutting a consultation
 * (ADR 0017). For each worker: set it draining through the coordinator service, wait until it runs nothing, move the
 * tag its VM follows to the build, call its VM's stack webhook, wait up to 2 minutes for a heartbeat with the new build
 * and a passing health check, and set it taking work again. A worker that is not healthy in time is rolled back, and
 * the deployment stops before the next one.
 */
import { type IRegistry, retag, tagExists } from './registry.ts';

/** What the coordinator service lists about a worker (`GET /workers`). */
export interface IWorkerStatus {
    build: string;
    capacity: number;
    draining: boolean;

    /** How many heartbeats the coordinator service has had from the worker; unset from an older coordinator service. */
    heartbeats?: number;
    id: string;
    kind: 'recorder-bot' | 'video-player';
    lost: boolean;
    running: number;
    url: string;
}

export interface IHealthCheck {
    secret?: string;
    url: string;
}

export interface IOptions {

    /** Recorder bots may be deployed when only one is in service: the night window's call sets this. */
    allowSingleRecorderBot?: boolean;

    /** The build to deploy: the commit's short hash, which is also an image tag. */
    build: string;
    coordinatorUrl: string;

    /** How long to wait for a worker to run nothing, in milliseconds. */
    drainTimeoutMs?: number;

    /** The worker's own health check, when the pipeline can reach it. */
    healthCheck?: (id: string) => IHealthCheck | undefined;

    /** How long a worker has to be healthy with the new build, in milliseconds: 2 minutes. */
    healthTimeoutMs?: number;

    /** The repository path of each kind's image, under the registry (for example `group/project/recorder-bot`). */
    images: Record<IWorkerStatus['kind'], string>;
    log?: (message: string) => void;
    pipelineSecret: string;
    pollMs?: number;
    registry: IRegistry;

    /** The webhook of the stack of the VM of a worker. */
    webhook: (id: string) => string | undefined;
}

/** How many heartbeats after a worker was set draining its `running` is trusted. */
const HEARTBEATS_AFTER_DRAINING = 2;

/** A deployment that stopped: the message says why and what state the workers are left in. */
export class DeployError extends Error {}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

/**
 * The tag the VM of a worker follows, so that one worker can move to a build while the others stay.
 *
 * @param {string} id - The worker's id.
 * @returns {string}
 */
export function workerTag(id: string): string {
    return `production-${id.replace(/[^A-Za-z0-9_.-]/gu, '-')}`;
}

/**
 * Deploys the build to every worker that is not on it yet.
 *
 * @param {IOptions} options - What to deploy and where.
 * @throws {DeployError} When a worker could not be deployed.
 * @returns {Promise<{ deployed: string[]; skipped: string[]; }>} The workers deployed, and the ones left for later
 * (the night window, or a worker that is lost).
 */
export async function deployWorkers(options: IOptions): Promise<{ deployed: string[]; skipped: string[]; }> {
    const log = options.log ?? (() => undefined);
    const pollMs = options.pollMs ?? 5000;
    const healthTimeoutMs = options.healthTimeoutMs ?? 120_000;
    const drainTimeoutMs = options.drainTimeoutMs ?? 4 * 60 * 60 * 1000;
    const base = options.coordinatorUrl.replace(/\/+$/u, '');
    const headers = { authorization: `Bearer ${options.pipelineSecret}`, 'content-type': 'application/json' };

    const list = async (): Promise<IWorkerStatus[]> => {
        const response = await fetch(`${base}/workers`, { headers, signal: AbortSignal.timeout(10_000) });

        if (!response.ok) {
            throw new DeployError(`the coordinator service refused the list of workers (HTTP ${response.status})`);
        }

        return ((await response.json()) as { workers: IWorkerStatus[]; }).workers;
    };

    // The coordinator service may be briefly unreachable: one failed look is not the end of the wait.
    const tryList = async () => list().catch(() => undefined);
    const setDraining = async (id: string, draining: boolean) => {
        const response = await fetch(`${base}/workers/${encodeURIComponent(id)}/draining`, {
            body: JSON.stringify({ draining }),
            headers,
            method: 'PUT',
            signal: AbortSignal.timeout(10_000)
        });

        if (!response.ok) {
            throw new DeployError(`cannot set ${id} ${draining ? 'draining' : 'taking work'} (HTTP ${response.status})`);
        }
    };
    const callWebhook = async (id: string) => {
        const url = options.webhook(id);

        if (!url) {
            throw new DeployError(`no webhook is set for ${id}`);
        }

        const response = await fetch(url, { method: 'POST', signal: AbortSignal.timeout(60_000) });

        if (!response.ok) {
            throw new DeployError(`the webhook of ${id} failed (HTTP ${response.status})`);
        }
    };
    const healthy = async (id: string, build: string) => {
        const worker = (await tryList())?.find(w => w.id === id);

        if (!worker || worker.lost || worker.build !== build) {
            return false;
        }

        const check = options.healthCheck?.(id);

        if (!check) {
            return true;
        }

        try {
            const response = await fetch(check.url, {
                headers: check.secret ? { authorization: `Bearer ${check.secret}` } : {},
                signal: AbortSignal.timeout(10_000)
            });

            return response.ok;
        } catch {
            return false;
        }
    };
    const waitHealthy = async (id: string, build: string) => {
        const until = Date.now() + healthTimeoutMs;

        do {
            if (await healthy(id, build)) {
                return true;
            }
            await sleep(pollMs);
        } while (Date.now() < until);

        return false;
    };

    const workers = await list();
    const draining = workers.filter(w => w.draining);

    if (draining.length) {
        throw new DeployError(`${draining.map(w => w.id).join(', ')} already draining: another deployment is running, `
            + 'or one stopped half way. Look at it, then set it taking work again before deploying');
    }

    const deployed: string[] = [];
    const skipped: string[] = [];
    const ordered = [ ...workers ].sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));

    for (const { build, id, kind, lost } of ordered) {
        if (lost) {
            log(`${id} is lost: left as it is`);
            skipped.push(id);
            continue;
        }
        if (build === options.build) {
            log(`${id} already runs ${options.build}`);
            continue;
        }

        // Look again: the steps before this one changed what is in service.
        const now = await list();

        if (kind === 'recorder-bot' && !options.allowSingleRecorderBot) {
            const inService = now.filter(w => w.kind === kind && !w.lost && !w.draining).length;

            if (inService < 2) {
                log(`${id}: only ${inService} recorder bot in service, left for the night window`);
                skipped.push(id);
                continue;
            }
        }

        const repository = options.images[kind];

        log(`${id}: draining`);
        await setDraining(id, true);

        // What the list says of what the worker runs may be a heartbeat from before it was set draining, and a
        // consultation handed to it just then is not in it. The heartbeat after the next one was sent after the
        // worker was set draining and after any such consultation started, so it is the first to be trusted.
        const beatsAtDrain = (await tryList())?.find(w => w.id === id)?.heartbeats;

        const drainUntil = Date.now() + drainTimeoutMs;

        for (;;) {
            const status = (await tryList())?.find(w => w.id === id);

            const fresh = beatsAtDrain === undefined || status?.heartbeats === undefined
                || status.heartbeats >= beatsAtDrain + HEARTBEATS_AFTER_DRAINING;

            if (!status || status.lost || status.running === 0 && fresh) {
                break;
            }
            if (Date.now() >= drainUntil) {
                await setDraining(id, false);
                throw new DeployError(`${id} still runs ${status.running} after the wait: left on ${status.build}, `
                    + 'taking work again, nothing deployed');
            }
            await sleep(pollMs);
        }

        log(`${id}: deploying ${options.build}`);
        await retag(options.registry, repository, options.build, workerTag(id));
        await callWebhook(id);

        if (await waitHealthy(id, options.build)) {
            await setDraining(id, false);
            log(`${id}: healthy on ${options.build}, taking work`);
            deployed.push(id);
            continue;
        }

        // Not healthy in time: put the previous build back, and stop.
        log(`${id}: not healthy within ${healthTimeoutMs / 1000} seconds, rolling back to ${build}`);
        if (!await tagExists(options.registry, repository, build)) {
            throw new DeployError(`${id} is not healthy on ${options.build} and its previous build (${build}) `
                + 'is not in the registry: left draining, needs a person');
        }
        await retag(options.registry, repository, build, workerTag(id));
        await callWebhook(id);
        if (!await waitHealthy(id, build)) {
            throw new DeployError(`${id} is not healthy on ${options.build} nor back on ${build}: left draining, `
                + 'needs a person');
        }
        await setDraining(id, false);
        throw new DeployError(`${id} was not healthy on ${options.build} within ${healthTimeoutMs / 1000} seconds: `
            + `rolled back to ${build}, the other workers are untouched`);
    }

    // Every worker of a kind is on the build: production follows it. One left for later keeps the old build.
    for (const kind of [ 'recorder-bot', 'video-player' ] as const) {
        const ofKind = workers.filter(w => w.kind === kind);

        if (ofKind.length && !ofKind.some(w => skipped.includes(w.id))) {
            await retag(options.registry, options.images[kind], options.build, 'production');
            log(`${options.images[kind]}: production moved to ${options.build}`);
        }
    }

    return { deployed, skipped };
}
