import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, it } from 'node:test';

import { redeployStack } from '../portainerStack.ts';

const TOKEN = 'ptr_test';
const FILE = 'services:\n  web:\n    image: ${REGISTRY_PREFIX}/web:${IMAGE_TAG:-latest}\n';

interface IFakeStack {
    AutoUpdate?: { Interval: string; Webhook: string; } | null;
    EndpointId: number;
    Env: Array<{ name: string; value: string; }>;
    GitConfig?: unknown;
    Id: number;
    Name: string;
    Webhook?: string;
}

/**
 * A fake Portainer that behaves as the real one does on an update: the stack's environment, webhook and auto update
 * become what the update holds, so an update that leaves one out clears it.
 *
 * @param {Partial<IFakeStack>} overrides - The stack's settings.
 * @param {Object} behaviour - How the fake misbehaves.
 * @returns {Promise<Object>}
 */
async function fakePortainer(overrides: Partial<IFakeStack> = {}, behaviour: { dropWebhook?: boolean; failPut?: number; } = {}) {
    const stack: IFakeStack = {
        EndpointId: 3,
        Env: [ { name: 'IMAGE_TAG', value: 'production' }, { name: 'DB_PASSWORD', value: 's3cret]"x' } ],
        Id: 1,
        Name: 'tele-meet',
        ...overrides
    };
    const puts: Array<{ body: Record<string, unknown>; url: string; }> = [];
    const server = createServer((req, res) => {
        const chunks: Buffer[] = [];

        req.on('data', c => chunks.push(c));
        req.on('end', () => {
            const reply = (status: number, body: unknown) => {
                res.writeHead(status, { 'content-type': 'application/json' });
                res.end(JSON.stringify(body));
            };

            if (req.headers['x-api-key'] !== TOKEN) {
                return reply(401, { message: 'Unauthorized' });
            }
            if (req.method === 'GET' && req.url === '/api/stacks/1') {
                return reply(200, stack);
            }
            if (req.method === 'GET' && req.url === '/api/stacks/1/file') {
                return reply(200, { StackFileContent: FILE });
            }
            if (req.method === 'PUT' && req.url?.startsWith('/api/stacks/1?')) {
                const body = JSON.parse(Buffer.concat(chunks).toString()) as Record<string, unknown>;

                puts.push({ body, url: req.url });
                if (behaviour.failPut) {
                    return reply(behaviour.failPut, { details: 'pull access denied', message: 'Failed to deploy a stack' });
                }
                stack.Env = body.Env as IFakeStack['Env'];
                stack.AutoUpdate = behaviour.dropWebhook ? null : body.AutoUpdate as IFakeStack['AutoUpdate'];
                stack.Webhook = behaviour.dropWebhook ? '' : body.Webhook as string | undefined;

                return reply(200, stack);
            }

            return reply(404, { message: 'not found' });
        });
    });

    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));

    return {
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        close: () => new Promise<void>(resolve => server.close(() => resolve())),
        puts,
        stack
    };
}

describe('redeploying a stack through Portainer (ADR 0021)', () => {
    it('sends the same compose file and environment back, pulling the images, on the stack\'s environment', async () => {
        const portainer = await fakePortainer();

        try {
            await redeployStack({ baseUrl: portainer.baseUrl, imageTag: 'production', stackId: 1, token: TOKEN });
            assert.equal(portainer.puts.length, 1);
            assert.equal(portainer.puts[0].url, '/api/stacks/1?endpointId=3');
            assert.deepEqual(portainer.puts[0].body, {
                Env: [ { name: 'IMAGE_TAG', value: 'production' }, { name: 'DB_PASSWORD', value: 's3cret]"x' } ],
                Prune: false,
                PullImage: true,
                StackFileContent: FILE
            });
        } finally {
            await portainer.close();
        }
    });

    it('resends the webhook and the auto update, so that Portainer keeps them', async () => {
        const AutoUpdate = { Interval: '', Webhook: 'b2f1c0de' };
        const portainer = await fakePortainer({ AutoUpdate, Webhook: 'b2f1c0de' });

        try {
            await redeployStack({ baseUrl: portainer.baseUrl, stackId: 1, token: TOKEN });
            assert.deepEqual(portainer.puts[0].body.AutoUpdate, AutoUpdate);
            assert.equal(portainer.puts[0].body.Webhook, 'b2f1c0de');
            assert.equal(portainer.stack.Webhook, 'b2f1c0de');
        } finally {
            await portainer.close();
        }
    });

    it('fails when Portainer turned the webhook off anyway', async () => {
        const portainer = await fakePortainer({ AutoUpdate: { Interval: '', Webhook: 'b2f1c0de' } }, { dropWebhook: true });

        try {
            await assert.rejects(redeployStack({ baseUrl: portainer.baseUrl, stackId: 1, token: TOKEN }),
                /turned its webhook off/u);
        } finally {
            await portainer.close();
        }
    });

    it('refuses a stack pinned to another tag, before updating it', async () => {
        const portainer = await fakePortainer({ Env: [ { name: 'IMAGE_TAG', value: '5053bfb0' } ] });

        try {
            await assert.rejects(
                redeployStack({ baseUrl: portainer.baseUrl, imageTag: 'production', stackId: 1, token: TOKEN }),
                /follows IMAGE_TAG "5053bfb0", not "production"/u);
            assert.equal(portainer.puts.length, 0);
        } finally {
            await portainer.close();
        }
    });

    it('refuses a stack deployed from Git', async () => {
        const portainer = await fakePortainer({ GitConfig: { URL: 'https://git.example/x.git' } });

        try {
            await assert.rejects(redeployStack({ baseUrl: portainer.baseUrl, stackId: 1, token: TOKEN }), /from Git/u);
            assert.equal(portainer.puts.length, 0);
        } finally {
            await portainer.close();
        }
    });

    it('says why Portainer refused, and never the token or a value of the environment', async () => {
        const portainer = await fakePortainer({}, { failPut: 500 });

        try {
            await assert.rejects(redeployStack({ baseUrl: portainer.baseUrl, stackId: 1, token: TOKEN }), (error: Error) => {
                assert.match(error.message, /HTTP 500.*pull access denied/u);
                assert.ok(!error.message.includes(TOKEN));
                assert.ok(!error.message.includes('s3cret'));

                return true;
            });
        } finally {
            await portainer.close();
        }
    });

    it('fails on a wrong token without updating anything', async () => {
        const portainer = await fakePortainer();

        try {
            await assert.rejects(redeployStack({ baseUrl: portainer.baseUrl, stackId: 1, token: 'wrong' }), /HTTP 401/u);
            assert.equal(portainer.puts.length, 0);
        } finally {
            await portainer.close();
        }
    });
});
