import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type IPlayerBrowser, type IPlayerCallbacks, type LaunchPlayer, Players } from '../src/players.ts';

describe('a stop while a browser is starting', () => {
    test('does not let the first browser take the slot of a later play in the room', async () => {
        const launches: { browser: IPlayerBrowser; callbacks: IPlayerCallbacks; release: () => void; stopped: boolean; }[] = [];
        const launch: LaunchPlayer = (_params, callbacks) => new Promise(resolve => {
            const entry = {
                browser: { stop: async () => {
                    entry.stopped = true;
                } },
                callbacks,
                release: () => resolve(entry.browser),
                stopped: false
            };

            launches.push(entry);
        });
        const players = new Players({ launch, maxRooms: 2 });
        const params = { room: 'HN/1', token: 't', videoUrl: 'https://x/v.mp4' };

        const first = players.play(params);

        assert.equal(await players.stop('HN/1'), true);

        const second = players.play(params);

        // The first browser finishes starting after its slot was freed and taken again.
        launches[0].release();
        await first;
        assert.equal(launches[0].stopped, true, 'the first browser is closed, not kept');

        launches[1].release();
        await second;
        assert.deepEqual(players.active(), [ 'HN/1' ]);
        assert.equal(launches[1].stopped, false);

        assert.equal(await players.stop('HN/1'), true);
        assert.equal(launches[1].stopped, true, 'stopping the room stops the second browser');
    });

    test('does not free the slot of a later play when the first launch fails', async () => {
        let rejectFirst: (error: Error) => void = () => undefined;
        let calls = 0;
        const launch: LaunchPlayer = () => new Promise((resolve, reject) => {
            if (calls++ === 0) {
                rejectFirst = reject;
            } else {
                resolve({ stop: async () => undefined });
            }
        });
        const players = new Players({ launch, maxRooms: 2 });
        const params = { room: 'HN/1', token: 't', videoUrl: 'https://x/v.mp4' };
        const first = players.play(params);

        await players.stop('HN/1');
        await players.play(params);
        rejectFirst(new Error('boom'));
        await assert.rejects(first, /boom/u);

        assert.deepEqual(players.active(), [ 'HN/1' ]);
    });
});
