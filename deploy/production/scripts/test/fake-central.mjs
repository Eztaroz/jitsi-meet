// A fake central stack for the tests of ../ci/*.sh: one HTTP server answering what the health checks ask of the web
// server, the front web server, the coordinator service, Prosody, Jicofo and the videobridge, a Portainer webhook, and
// Portainer's API for stack 1 (ADR 0021; its token is test-token). An update of the stack through the API counts as a call
// of the webhook.
// Settings (environment): PORT; BROKEN, a comma list of what answers badly: front, web, config, standby, rooms, prosody,
// jicofo, jvb; HEAL_AFTER_MS, after which nothing is broken; HEAL_ON_HOOK=1, nothing is broken once the webhook is called;
// STACK_IMAGE_TAG, the IMAGE_TAG of stack 1 (production).
import { createServer } from 'node:http';

const SECRET = 'test-secret';
const PORTAINER_TOKEN = 'test-token';
const stack = { EndpointId: 3, Env: [ { name: 'IMAGE_TAG', value: process.env.STACK_IMAGE_TAG ?? 'production' } ], Id: 1 };
const broken = new Set((process.env.BROKEN ?? '').split(',').filter(Boolean));
let hooks = 0;

if (process.env.HEAL_AFTER_MS) {
    setTimeout(() => broken.clear(), Number(process.env.HEAL_AFTER_MS));
}

const hook = () => {
    hooks++;
    if (process.env.HEAL_ON_HOOK === '1') {
        broken.clear();
    }
};

createServer(async (req, res) => {
    const { pathname, search } = new URL(req.url, 'http://localhost');
    const reply = (status, body = '', headers = {}) => {
        res.writeHead(status, headers);
        res.end(body);
    };
    const authorised = req.headers.authorization === `Bearer ${SECRET}`;

    if (req.method === 'POST' && pathname === '/hook') {
        hook();

        return reply(204);
    }
    if (pathname.startsWith('/api/')) {
        if (req.headers['x-api-key'] !== PORTAINER_TOKEN) {
            return reply(401, '{"message":"Unauthorized"}');
        }
        if (req.method === 'GET' && pathname === '/api/stacks/1') {
            return reply(200, JSON.stringify(stack));
        }
        if (req.method === 'GET' && pathname === '/api/stacks/1/file') {
            return reply(200, '{"StackFileContent":"services: {}"}');
        }
        if (req.method === 'PUT' && pathname === '/api/stacks/1' && search === '?endpointId=3') {
            let body = '';

            for await (const chunk of req) {
                body += chunk;
            }
            stack.Env = JSON.parse(body).Env;
            hook();

            return reply(200, JSON.stringify(stack));
        }

        return reply(404, '{"message":"not found"}');
    }
    if (pathname === '/hook-count') {
        return reply(200, String(hooks));
    }
    if (pathname === '/coordinator/health') {
        if (!authorised) {
            return reply(401, '{}');
        }

        return broken.has('standby')
            ? reply(503, '{"active":false,"status":"standby"}')
            : reply(200, '{"active":true,"openEncounters":0,"status":"ok"}');
    }
    if (pathname === '/coordinator/rooms') {
        if (!authorised) {
            return reply(401, '{}');
        }

        return broken.has('rooms') ? reply(503, '{"error":"Prosody cannot be asked now"}') : reply(200, '{"rooms":[]}');
    }
    if (pathname === '/front-health') {
        return broken.has('front') ? reply(502) : reply(200, 'ok\n');
    }
    if (pathname === '/' || pathname === '/config.js') {
        if (broken.has('web') || (pathname === '/config.js' && broken.has('config'))) {
            return reply(503, 'maintenance', { 'X-Maintenance': '1' });
        }

        return reply(200, pathname === '/' ? '<html>Jitsi</html>' : 'var config = {};');
    }
    if (pathname === '/http-bind') {
        return broken.has('prosody') ? reply(502) : reply(200, 'It works');
    }
    if (pathname === '/jicofo-health') {
        return broken.has('jicofo') ? reply(500) : reply(200);
    }
    if (pathname === '/jvb-health') {
        return broken.has('jvb') ? reply(500) : reply(200);
    }

    return reply(404);
}).listen(Number(process.env.PORT), '127.0.0.1');
