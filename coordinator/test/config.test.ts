import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadConfig, loadLayout } from '../src/config.ts';

/**
 * Writes a rooms file.
 *
 * @param {unknown} content - Its JSON.
 * @returns {string} Its path.
 */
function roomsFile(content: unknown): string {
    const file = join(mkdtempSync(join(tmpdir(), 'layout-')), 'rooms.json');

    writeFileSync(file, JSON.stringify(content));

    return file;
}

describe('the stations and lounges file', () => {
    it('has none when no file is configured', () => {
        assert.deepEqual(loadLayout(undefined), { lounges: [], stations: [] });
    });

    it('reads stations with their stage, and lounges', () => {
        const layout = loadLayout(roomsFile({
            lounges: [ { room: 'lounge-1' } ],
            stations: [ { room: 'intake-1', stage: 'intake' }, { room: 'aftercare-1', stage: 'aftercare' } ]
        }));

        assert.deepEqual(layout, {
            lounges: [ { room: 'lounge-1' } ],
            stations: [ { room: 'intake-1', stage: 'intake' }, { room: 'aftercare-1', stage: 'aftercare' } ]
        });
    });

    it('refuses a station without a known stage', () => {
        assert.throws(() => loadLayout(roomsFile({ stations: [ { room: 'x', stage: 'examination' } ] })), /stage/u);
    });

    it('refuses a room without a name', () => {
        assert.throws(() => loadLayout(roomsFile({ lounges: [ {} ] })), /room/u);
    });
});

describe('the prepare wait', () => {
    const env = (extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv => ({
        COORDINATOR_API_SECRET: 'secret',
        COORDINATOR_PROSODY_URL: 'http://prosody:5280',
        COORDINATOR_RECORDER_BOT_SECRET: 'bot-secret',
        COORDINATOR_RECORDER_BOT_URL: 'http://bot:8090',
        COORDINATOR_SIGNING_KEY_FILE: roomsFile({}),
        COORDINATOR_SIGNING_KID: 'kid',
        COORDINATOR_TOKEN_SUBJECT: 'meet.example',
        ...extra
    });

    it('is 30 seconds when COORDINATOR_PREPARE_WAIT_SECONDS is unset', () => {
        assert.equal(loadConfig(env()).prepareWaitMs, 30_000);
    });

    it('is set by COORDINATOR_PREPARE_WAIT_SECONDS', () => {
        assert.equal(loadConfig(env({ COORDINATOR_PREPARE_WAIT_SECONDS: '4' })).prepareWaitMs, 4000);
    });

    it('refuses a wait that is not a positive number', () => {
        assert.throws(() => loadConfig(env({ COORDINATOR_PREPARE_WAIT_SECONDS: 'soon' })), /COORDINATOR_PREPARE_WAIT_SECONDS/u);
        assert.throws(() => loadConfig(env({ COORDINATOR_PREPARE_WAIT_SECONDS: '0' })), /COORDINATOR_PREPARE_WAIT_SECONDS/u);
    });
});
