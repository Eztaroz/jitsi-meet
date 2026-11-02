/**
 * Global configuration that the tests are run with. Loaded from environment variables.
 */
export const config = {
    /** Enable debug logging. Note this includes private information from .env */
    debug: Boolean(process.env.JITSI_DEBUG?.trim()),
    expectationsFile: process.env.EXPECTATIONS?.trim(),
    jaas: {
        customerId: (() => {
            if (typeof process.env.JAAS_TENANT !== 'undefined') {
                return process.env.JAAS_TENANT?.trim()?.replace('vpaas-magic-cookie-', '');
            }

            return process.env.IFRAME_TENANT?.trim()?.replace('vpaas-magic-cookie-', '');
        })(),
        /** Whether the configuration for JaaS specific tests is enabled. */
        enabled: Boolean(
            (process.env.JAAS_TENANT || process.env.IFRAME_TENANT)
            && (process.env.JAAS_PRIVATE_KEY_PATH || process.env.JWT_PRIVATE_KEY_PATH)
            && (process.env.JAAS_KID || process.env.JWT_KID)),
        /** The JaaS key ID, used to sign the tokens. */
        kid: (() => {
            if (typeof process.env.JAAS_KID !== 'undefined') {
                return process.env.JAAS_KID?.trim();
            }

            return process.env.JWT_KID?.trim();
        })(),
        /** The path to the JaaS private key, used to sign JaaS tokens. */
        privateKeyPath: (() => {
            if (typeof process.env.JAAS_PRIVATE_KEY_PATH != 'undefined') {
                return process.env.JAAS_PRIVATE_KEY_PATH?.trim();
            }

            return process.env.JWT_PRIVATE_KEY_PATH?.trim();
        })(),
        /** The JaaS tenant (vpaas-magic-cookie-<ID>) . */
        tenant: (() => {
            if (typeof process.env.JAAS_TENANT !== 'undefined') {
                return process.env.JAAS_TENANT?.trim();
            }

            return process.env.IFRAME_TENANT?.trim();
        })()
    },
    jwt: {
        kid: process.env.JWT_KID?.trim(),
        /** A pre-configured token used by some tests. */
        preconfiguredJwt: process.env.JWT_ACCESS_TOKEN?.trim(),
        preconfiguredToken: (() => {
            if (process.env.JWT_ACCESS_TOKEN) {
                return { jwt: process.env.JWT_ACCESS_TOKEN?.trim() };
            }

            return undefined;
        })(),
        privateKeyPath: process.env.JWT_PRIVATE_KEY_PATH?.trim()
    },
    coordinator: {
        /** The bearer secret of the coordinator service's API. */
        apiSecret: process.env.COORDINATOR_API_SECRET?.trim(),
        /** The coordinator service's API through the web server's proxy, e.g. https://localhost:8443/coordinator. */
        apiUrl: process.env.COORDINATOR_API_URL?.trim()?.replace(/\/+$/, ''),
        /** The docker container the coordinator service runs in, so that the tests can restart it. */
        container: process.env.COORDINATOR_CONTAINER?.trim()
    },
    recorderBot: {
        /** The bearer secret of the recorder bot service's control API. */
        apiSecret: process.env.RECORDER_BOT_API_SECRET?.trim(),
        /** The recorder bot service's control API, e.g. http://localhost:8090. */
        apiUrl: process.env.RECORDER_BOT_API_URL?.trim()?.replace(/\/+$/, ''),
        /**
         * The control API of a second instance of the service, configured to record at most one consultation at a
         * time, for the capacity tests. Same bearer secret.
         */
        limitedApiUrl: process.env.RECORDER_BOT_LIMITED_API_URL?.trim()?.replace(/\/+$/, ''),
        /** The service's evidence storage root as this machine sees it, absolute or relative to tests/. */
        storageRoot: process.env.RECORDER_BOT_STORAGE_ROOT?.trim(),
        /**
         * The docker container the main instance of the service runs in, so that the relaunch tests can kill a
         * bot's browser.
         */
        container: process.env.RECORDER_BOT_CONTAINER?.trim(),
        /**
         * The control API of an instance of the service configured never to relaunch a crashed bot
         * (RECORDER_BOT_MAX_RELAUNCHES=0), and its docker container. Same bearer secret.
         */
        fragileApiUrl: process.env.RECORDER_BOT_FRAGILE_API_URL?.trim()?.replace(/\/+$/, ''),
        fragileContainer: process.env.RECORDER_BOT_FRAGILE_CONTAINER?.trim(),
        /**
         * An instance of the service with a storage root of its own, which the storage tests take away and give back
         * and the retention tests seed: its control API (same bearer secret), its storage root and its spool as this
         * machine sees them, its docker container, how often it retries spooled evidence recordings and sweeps, in
         * seconds, and its retention period, in days.
         */
        isolated: {
            apiUrl: process.env.RECORDER_BOT_ISOLATED_API_URL?.trim()?.replace(/\/+$/, ''),
            container: process.env.RECORDER_BOT_ISOLATED_CONTAINER?.trim(),
            retentionDays: Number(process.env.RECORDER_BOT_ISOLATED_RETENTION_DAYS?.trim() || '0'),
            retrySeconds: Number(process.env.RECORDER_BOT_ISOLATED_STORE_RETRY_SECONDS?.trim() || '0'),
            sweepSeconds: Number(process.env.RECORDER_BOT_ISOLATED_RETENTION_SWEEP_SECONDS?.trim() || '0'),
            spool: process.env.RECORDER_BOT_ISOLATED_SPOOL?.trim(),
            storageRoot: process.env.RECORDER_BOT_ISOLATED_STORAGE_ROOT?.trim()
        }
    },
    roomName: {
        /** Optional fixed room name that overrides the generated one entirely. */
        name: process.env.ROOM_NAME?.trim(),
        /** Optional prefix for room names used for tests. */
        prefix: process.env.ROOM_NAME_PREFIX?.trim(),
        /** Optional suffix for room names used for tests. */
        suffix: process.env.ROOM_NAME_SUFFIX?.trim()
    },
    webhooksProxy: {
        enabled: Boolean(process.env.WEBHOOKS_PROXY_URL && process.env.WEBHOOKS_PROXY_SHARED_SECRET),
        sharedSecret: process.env.WEBHOOKS_PROXY_SHARED_SECRET?.trim(),
        url: process.env.WEBHOOKS_PROXY_URL?.trim(),
    }
};

if (config.debug) {
    console.log('TestsConfig:', JSON.stringify(config, null, 2));
}
