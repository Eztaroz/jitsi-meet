/**
 * Moves a tag of an image in a registry to another tag of the same repository, by copying the manifest (the layers are
 * shared, nothing is uploaded). The pipeline has no Docker daemon, so this speaks the registry's HTTP API itself (the
 * same one `crane tag` uses), including the token handshake the GitLab registry asks for.
 */

const MANIFEST_TYPES = [
    'application/vnd.oci.image.index.v1+json',
    'application/vnd.docker.distribution.manifest.list.v2+json',
    'application/vnd.oci.image.manifest.v1+json',
    'application/vnd.docker.distribution.manifest.v2+json'
];

export interface IRegistry {

    /** `user:password`, as the CI/CD variable holds it, base64 encoded. */
    auth: string;

    /** For example `https://registry.example.org`. */
    baseUrl: string;
}

const tokens = new Map<string, string>();

/**
 * Calls the registry, answering its challenge when it asks for credentials.
 *
 * @param {IRegistry} registry - The registry.
 * @param {string} repository - The repository the call is about, for the token's scope.
 * @param {string} path - The path under the registry's address.
 * @param {RequestInit} init - The request.
 * @returns {Promise<Response>}
 */
async function call(registry: IRegistry, repository: string, path: string, init: RequestInit = {}): Promise<Response> {
    const url = `${registry.baseUrl}${path}`;
    const withAuth = (value?: string): RequestInit => ({
        ...init,
        headers: { ...init.headers as Record<string, string>, ...value ? { authorization: value } : {} }
    });
    const cached = tokens.get(`${registry.baseUrl}|${repository}`);
    let response = await fetch(url, withAuth(cached ? `Bearer ${cached}` : undefined));

    if (response.status !== 401) {
        return response;
    }

    const challenge = response.headers.get('www-authenticate') ?? '';

    await response.arrayBuffer();
    if (/^basic/iu.test(challenge)) {
        return fetch(url, withAuth(`Basic ${registry.auth}`));
    }

    const realm = /realm="([^"]+)"/u.exec(challenge)?.[1];
    const service = /service="([^"]+)"/u.exec(challenge)?.[1];

    if (!realm) {
        throw new Error('the registry refused the credentials and did not say how to log in');
    }

    const tokenUrl = new URL(realm);

    if (service) {
        tokenUrl.searchParams.set('service', service);
    }
    tokenUrl.searchParams.set('scope', `repository:${repository}:pull,push`);

    const tokenResponse = await fetch(tokenUrl, { headers: { authorization: `Basic ${registry.auth}` } });

    if (!tokenResponse.ok) {
        throw new Error(`the registry's token service refused the credentials (HTTP ${tokenResponse.status})`);
    }

    const body = await tokenResponse.json() as { access_token?: string; token?: string; };
    const token = body.token ?? body.access_token;

    if (!token) {
        throw new Error('the registry\'s token service gave no token');
    }
    tokens.set(`${registry.baseUrl}|${repository}`, token);
    response = await fetch(url, withAuth(`Bearer ${token}`));

    return response;
}

/**
 * Whether a tag exists.
 *
 * @param {IRegistry} registry - The registry.
 * @param {string} repository - For example `group/project/recorder-bot`.
 * @param {string} tag - The tag.
 * @returns {Promise<boolean>}
 */
export async function tagExists(registry: IRegistry, repository: string, tag: string): Promise<boolean> {
    const response = await call(registry, repository, `/v2/${repository}/manifests/${encodeURIComponent(tag)}`, {
        headers: { accept: MANIFEST_TYPES.join(', ') },
        method: 'HEAD'
    });

    return response.ok;
}

/**
 * Makes `to` point at what `from` points at.
 *
 * @param {IRegistry} registry - The registry.
 * @param {string} repository - For example `group/project/recorder-bot`.
 * @param {string} from - The tag to copy.
 * @param {string} to - The tag to move.
 * @throws {Error} When `from` does not exist or the registry refuses.
 * @returns {Promise<void>}
 */
export async function retag(registry: IRegistry, repository: string, from: string, to: string): Promise<void> {
    const got = await call(registry, repository, `/v2/${repository}/manifests/${encodeURIComponent(from)}`, {
        headers: { accept: MANIFEST_TYPES.join(', ') }
    });

    if (!got.ok) {
        throw new Error(`cannot read ${repository}:${from} (HTTP ${got.status})`);
    }

    const type = got.headers.get('content-type') ?? MANIFEST_TYPES[3];
    const manifest = Buffer.from(await got.arrayBuffer());
    const put = await call(registry, repository, `/v2/${repository}/manifests/${encodeURIComponent(to)}`, {
        body: manifest,
        headers: { 'content-type': type },
        method: 'PUT'
    });

    if (!put.ok) {
        throw new Error(`cannot tag ${repository}:${to} (HTTP ${put.status})`);
    }
}
