/**
 * The pipeline's entry point for the workers (ADR 0017): `node deploy/pipeline/deployWorkersMain.ts`. It reads its
 * settings from CI/CD variables, so that no secret and no internal name is in the repository:
 *
 *   COORDINATOR_URL              the coordinator service's address, as the runner reaches it
 *   COORDINATOR_PIPELINE_SECRET  the pipeline's own secret (not a worker's, not the hospital system's)
 *   REGISTRY, IMAGE_PREFIX       as for the image jobs; REGISTRY_AUTH is base64 of "user:password"
 *   WEBHOOK_<ID>                 the webhook of the stack of the VM of the worker with that id
 *                                (the id in capitals, every other character an underscore: bot-1 is WEBHOOK_BOT_1)
 *   HEALTH_URL_<ID>              optional: the worker's own health check, with HEALTH_SECRET_<ID> as its bearer secret
 *   ALLOW_SINGLE_RECORDER_BOT=1  the night window's call: deploy a recorder bot even if it is the only one
 *   ALLOW_SELF_SIGNED=1          the internal services use a certificate the runner does not know
 *
 * The build is the commit's first 8 characters, as the image jobs tag it.
 */
import { DeployError, deployWorkers } from './deployWorkers.ts';

const { env } = process;
const required = (name: string) => {
    const value = env[name]?.trim();

    if (!value) {
        console.error(`ERROR: ${name} is empty: set the CI/CD variable`);
        process.exit(1);
    }

    return value;
};
const forWorker = (prefix: string, id: string) =>
    env[`${prefix}_${id.toUpperCase().replace(/[^A-Z0-9]/gu, '_')}`]?.trim();

if (env.ALLOW_SELF_SIGNED === '1') {
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const prefix = required('IMAGE_PREFIX').replace(/\/+$/u, '');
const registryHost = required('REGISTRY');
const path = prefix.startsWith(`${registryHost}/`) ? prefix.slice(registryHost.length + 1) : prefix;

try {
    const result = await deployWorkers({
        allowSingleRecorderBot: env.ALLOW_SINGLE_RECORDER_BOT === '1',
        build: required('CI_COMMIT_SHA').slice(0, 8),
        coordinatorUrl: required('COORDINATOR_URL'),
        healthCheck: id => {
            const url = forWorker('HEALTH_URL', id);

            return url ? { secret: forWorker('HEALTH_SECRET', id), url } : undefined;
        },
        images: { 'recorder-bot': `${path}/recorder-bot`, 'video-player': `${path}/video-player` },
        log: message => console.log(message),
        pipelineSecret: required('COORDINATOR_PIPELINE_SECRET'),
        registry: { auth: required('REGISTRY_AUTH'), baseUrl: `https://${registryHost}` },
        webhook: id => forWorker('WEBHOOK', id)
    });

    console.log(`deployed: ${result.deployed.join(', ') || 'none'}; left for later: ${result.skipped.join(', ') || 'none'}`);
} catch (error) {
    console.error(`ERROR: ${error instanceof DeployError ? error.message : (error as Error).stack}`);
    process.exit(1);
}
