/**
 * Redeploys a central stack through Portainer's API (ADR 0021): `node deploy/pipeline/redeployStackMain.ts <PREFIX>`.
 * redeploy-central.sh calls it, and then runs the health checks. Its settings are CI/CD variables, prefixed with
 * <PREFIX>_ (TEST or PRODUCTION):
 *
 *   PORTAINER_URL       Portainer's address, e.g. https://<host>:9443
 *   PORTAINER_TOKEN     the access token of a Portainer user who can update this stack only (Protected + Masked)
 *   STACK_ID            the stack's id, from its address in Portainer (#!/<environment>/docker/stacks/<name>?id=<id>)
 *   PORTAINER_INSECURE  1 when Portainer's certificate is self-signed
 *   IMAGE_TAG           the tag the stack must follow; `production` for PRODUCTION (ADR 0017) unless set
 */
import { RedeployError, redeployStack } from './portainerStack.ts';

const { env } = process;
const prefix = process.argv[2];

if (!prefix) {
    console.error('usage: redeployStackMain.ts <PREFIX>');
    process.exit(2);
}

const required = (name: string) => {
    const value = env[`${prefix}_${name}`]?.trim();

    if (!value) {
        console.error(`ERROR: ${prefix}_${name} is empty: set the CI/CD variable`);
        process.exit(1);
    }

    return value;
};

if (env[`${prefix}_PORTAINER_INSECURE`] === '1') {
    env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
}

const stackId = Number(required('STACK_ID'));

if (!Number.isInteger(stackId) || stackId <= 0) {
    console.error(`ERROR: ${prefix}_STACK_ID is not a stack id`);
    process.exit(1);
}

try {
    await redeployStack({
        baseUrl: required('PORTAINER_URL'),
        imageTag: env[`${prefix}_IMAGE_TAG`]?.trim() || (prefix === 'PRODUCTION' ? 'production' : undefined),
        log: message => console.log(message),
        stackId,
        token: required('PORTAINER_TOKEN')
    });
} catch (error) {
    console.error(`ERROR: ${error instanceof RedeployError ? error.message : (error as Error).stack}`);
    process.exit(1);
}
