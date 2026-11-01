import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import type { CoordinatorService } from '../src/coordinatorService.ts';
import { HttpError } from '../src/http.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import type { ICoordinatorAuth } from '../src/screenAuth.ts';
import { createScreenRoutes } from '../src/screenRoutes.ts';

describe('the coordinator screen files', () => {
    let server: Server;
    let base: string;

    before(async () => {
        const handle = createScreenRoutes({
            act: async () => false,
            screen: {
                acceptedAudiences: [],
                acceptedIssuers: [],
                keyFor: async () => undefined,
                marker: parseRoleMarker('user.hospital_role=coordinator', 'X') as never
            } as ICoordinatorAuth,
            service: {} as CoordinatorService
        });

        server = createServer((req, res) => {
            handle(req, res, undefined).catch(error => {
                res.writeHead(error instanceof HttpError ? error.status : 500).end();
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
    });

    it('serves the screen script as JavaScript', async () => {
        const response = await fetch(`${base}/screen/screen.js`);

        assert.equal(response.status, 200);
        assert.equal(response.headers.get('content-type'), 'text/javascript; charset=utf-8');
    });

    it('serves the screen script with its types stripped', async () => {
        const body = await (await fetch(`${base}/screen/screen.js`)).text();

        assert.match(body, /coordinator-token/);
        assert.doesNotMatch(body, /\binterface\s+\w+\s*\{/);
        assert.doesNotMatch(body, /\bas (HTML\w+|string|unknown)\b/);
        assert.doesNotMatch(body, /\)\s*:\s*(void|string|boolean|Promise<[^>]*>)\s*(\{|=>)/);
    });

    it('does not serve the TypeScript source', async () => {
        const response = await fetch(`${base}/screen/screen.ts`);

        assert.equal(response.status, 404);
    });

    // Behind the web server's proxy the screen lives at /coordinator/screen (ADR 0008), so nothing it loads or calls
    // may start with "/": a root-absolute URL would leave the prefix.
    it('loads its assets by relative URLs', async () => {
        const page = await (await fetch(`${base}/screen`)).text();
        const urls = [ ...page.matchAll(/\b(?:href|src)="([^"]*)"/g) ].map(match => match[1]);

        assert.deepEqual(urls.filter(url => url.startsWith('/')), []);
        assert.ok(urls.includes('screen/screen.css'));
        assert.ok(urls.includes('screen/screen.js'));
    });

    it('calls its API by relative URLs', async () => {
        const script = await (await fetch(`${base}/screen/screen.js`)).text();
        const calls = [ ...script.matchAll(/fetch\(\s*[`'"]([^`'"]*)/g) ].map(match => match[1]);

        assert.ok(calls.length > 0);
        assert.deepEqual(calls.filter(url => url.startsWith('/')), []);
    });
});
