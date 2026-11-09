import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, test } from 'node:test';

import { createApi } from '../src/api.ts';
import { type IPlayerBrowser, type IPlayerCallbacks, type IPlayerParams, type LaunchPlayer, Players } from '../src/players.ts';

const SECRET = 'test-secret';

/** A browser the test controls: it records what it was asked and lets the test end the video or crash it. */
interface IFakeBrowser {
    callbacks: IPlayerCallbacks;
    params: IPlayerParams;
    stopped: boolean;
}

let server: Server;
let base: string;
let browsers: IFakeBrowser[];
let launchFails: boolean;

/**
 * Starts the API over a fake browser.
 *
 * @param {number} maxRooms - The capacity.
 * @returns {Promise<void>}
 */
async function start(maxRooms = 2) {
    const launch: LaunchPlayer = async (params, callbacks): Promise<IPlayerBrowser> => {
        if (launchFails) {
            throw new Error('no browser');
        }

        const browser: IFakeBrowser = { callbacks, params, stopped: false };

        browsers.push(browser);

        return {
            async stop() {
                browser.stopped = true;
            }
        };
    };

    server = createApi({ maxRooms, players: new Players({ launch, maxRooms }), secret: SECRET });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
}

/**
 * Calls the API.
 *
 * @param {string} method - The HTTP method.
 * @param {string} path - The path.
 * @param {unknown} body - The JSON body, if any.
 * @param {string|null} secret - The bearer secret to send; none when null.
 * @returns {Promise<{ body: { rooms: string[]; }; status: number; }>}
 */
async function call(method: string, path: string, body?: unknown, secret: string | null = SECRET) {
    const response = await fetch(`${base}${path}`, {
        body: body === undefined ? undefined : JSON.stringify(body),
        headers: secret === null ? {} : { authorization: `Bearer ${secret}` },
        method
    });

    return { body: await response.json() as { rooms: string[]; }, status: response.status };
}

const play = (room: string, extra: object = {}) =>
    call('POST', '/play', { room, token: 'jwt-for-room', videoUrl: 'https://meet.example.org/videos/a.mp4', ...extra });

beforeEach(() => {
    browsers = [];
    launchFails = false;
});

afterEach(async () => {
    await new Promise(resolve => server.close(resolve));
});

describe('the bearer secret', () => {
    test('refuses every request without it or with a wrong one', async () => {
        await start();

        for (const secret of [ null, 'wrong' ]) {
            assert.equal((await call('GET', '/health', undefined, secret)).status, 401);
            assert.equal((await call('POST', '/play', { room: 'r', token: 't', videoUrl: 'https://x/a.mp4' }, secret)).status, 401);
            assert.equal((await call('POST', '/stop', { room: 'r' }, secret)).status, 401);
        }
        assert.equal(browsers.length, 0);
    });
});

describe('play', () => {
    test('opens a browser for the room with its token and video, and health reports the room', async () => {
        await start();

        const played = await play('room-1');

        assert.equal(played.status, 201);
        assert.deepEqual(played.body, { room: 'room-1', status: 'playing' });
        assert.equal(browsers.length, 1);
        assert.deepEqual(browsers[0].params, {
            room: 'room-1',
            token: 'jwt-for-room',
            videoUrl: 'https://meet.example.org/videos/a.mp4'
        });
        assert.deepEqual((await call('GET', '/health')).body, {
            activeRooms: 1,
            maxRooms: 2,
            rooms: [ 'room-1' ],
            status: 'ok'
        });
    });

    test('refuses a request without a room, a token or an http(s) video', async () => {
        await start();

        assert.equal((await play('')).status, 400);
        assert.equal((await play('r', { token: '' })).status, 400);
        assert.equal((await play('r', { videoUrl: 'file:///etc/passwd' })).status, 400);
        assert.equal((await play('r', { videoUrl: 'not a url' })).status, 400);
        assert.equal(browsers.length, 0);
    });

    test('refuses a second video in a room that is already playing one', async () => {
        await start();
        await play('room-1');

        assert.equal((await play('room-1')).status, 409);
        assert.equal(browsers.length, 1);
    });

    test('refuses above capacity, and accepts again once a room is free', async () => {
        await start(2);
        await play('room-1');
        await play('room-2');

        assert.equal((await play('room-3')).status, 503);
        assert.equal(browsers.length, 2);

        await call('POST', '/stop', { room: 'room-1' });

        assert.equal((await play('room-3')).status, 201);
    });

    test('answers 502 and frees the slot when the browser cannot start', async () => {
        await start(1);
        launchFails = true;

        assert.equal((await play('room-1')).status, 502);

        launchFails = false;

        assert.equal((await play('room-1')).status, 201);
    });
});

describe('stop', () => {
    test('stops the browser and frees the room', async () => {
        await start();
        await play('room-1');

        const stopped = await call('POST', '/stop', { room: 'room-1' });

        assert.equal(stopped.status, 200);
        assert.equal(browsers[0].stopped, true);
        assert.deepEqual((await call('GET', '/health')).body.rooms, []);
    });

    test('answers 404 for a room that is not playing', async () => {
        await start();

        assert.equal((await call('POST', '/stop', { room: 'nowhere' })).status, 404);
    });
});

describe('a video that ends', () => {
    test('makes the video player leave: the browser is stopped and the room freed', async () => {
        await start();
        await play('room-1');

        browsers[0].callbacks.onEnded();
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(browsers[0].stopped, true);
        assert.deepEqual((await call('GET', '/health')).body.rooms, []);
        assert.equal((await call('POST', '/stop', { room: 'room-1' })).status, 404);
    });

    test('is the same when the browser crashes or fails to join', async () => {
        await start();
        await play('room-1');
        await play('room-2');

        browsers[0].callbacks.onFailed('browser_disconnected');
        browsers[1].callbacks.onFailed('conference_failed');
        await new Promise(resolve => setImmediate(resolve));

        assert.equal(browsers[0].stopped, true);
        assert.equal(browsers[1].stopped, true);
        assert.deepEqual((await call('GET', '/health')).body.rooms, []);
    });
});
