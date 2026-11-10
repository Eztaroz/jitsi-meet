import assert from 'node:assert/strict';
import { type Server, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { VideoPlayer, VideoPlayerUnavailableError } from '../src/videoPlayer.ts';

describe('the video player client', () => {
    let server: Server;
    let url: string;
    let playDelayMs: number;
    let stopped: string[];

    beforeEach(async () => {
        playDelayMs = 0;
        stopped = [];
        server = createServer((req, res) => {
            let body = '';

            req.on('data', chunk => {
                body += chunk;
            });
            req.on('end', () => {
                if (req.url === '/stop') {
                    stopped.push((JSON.parse(body) as { room: string; }).room);
                    res.writeHead(200).end('{}');

                    return;
                }
                setTimeout(() => res.writeHead(202).end('{}'), playDelayMs);
            });
        });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterEach(() => {
        server.close();
        server.closeAllConnections();
    });

    const request = { room: 'HN/1', token: 't', videoUrl: 'https://meet.example/v.mp4' };

    it('waits for a slow start as long as the play timeout allows', async () => {
        playDelayMs = 150;

        await new VideoPlayer(url, 's', { playTimeoutMs: 2000 }).play(request);

        assert.deepEqual(stopped, []);
    });

    it('stops the room, best-effort, when the start times out, and reports it unreachable', async () => {
        playDelayMs = 500;

        await assert.rejects(new VideoPlayer(url, 's', { playTimeoutMs: 50 }).play(request),
            (error: VideoPlayerUnavailableError) => error.code === 'unreachable');
        assert.deepEqual(stopped, [ 'HN/1' ]);
    });

    it('does not mind that the best-effort stop fails too', async () => {
        const player = new VideoPlayer('http://127.0.0.1:1', 's', { playTimeoutMs: 50 });

        await assert.rejects(player.play(request), (error: VideoPlayerUnavailableError) => error.code === 'unreachable');
    });
});
