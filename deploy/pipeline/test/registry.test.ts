import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { it } from 'node:test';

import { retag, tagExists } from '../registry.ts';

it('answers the registry token challenge, then copies a manifest to a new tag', async () => {
    const puts: Array<{ body: string; path: string; type?: string; }> = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];

        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

            if (req.url?.startsWith('/token')) {
                assert.equal(req.headers.authorization, 'Basic dXNlcjpwdw==');
                assert.match(req.url, /scope=repository%3Ag%2Fp%2Fbot%3Apull%2Cpush/u);
                res.end(JSON.stringify({ token: 't0k' }));

                return;
            }
            if (req.headers.authorization !== 'Bearer t0k') {
                res.writeHead(401, { 'www-authenticate': `Bearer realm="${base}/token",service="registry"` });
                res.end();

                return;
            }
            if (req.method === 'PUT') {
                puts.push({ body: Buffer.concat(chunks).toString(), path: req.url!, type: req.headers['content-type'] });
                res.writeHead(201);
                res.end();

                return;
            }
            if (req.url === '/v2/g/p/bot/manifests/abc') {
                res.writeHead(200, { 'content-type': 'application/vnd.oci.image.index.v1+json' });
                res.end('{"manifests":[]}');

                return;
            }
            res.writeHead(404);
            res.end();
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    const registry = { auth: 'dXNlcjpwdw==', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };

    try {
        assert.equal(await tagExists(registry, 'g/p/bot', 'abc'), true);
        assert.equal(await tagExists(registry, 'g/p/bot', 'missing'), false);
        await retag(registry, 'g/p/bot', 'abc', 'production');
        assert.deepEqual(puts, [ {
            body: '{"manifests":[]}', path: '/v2/g/p/bot/manifests/production',
            type: 'application/vnd.oci.image.index.v1+json'
        } ]);
        await assert.rejects(retag(registry, 'g/p/bot', 'missing', 'production'), /cannot read/u);
    } finally {
        server.close();
    }
});
