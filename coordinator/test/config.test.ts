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

describe('the rooms file', () => {
    const center = (stations: unknown[]) => ({ centers: [ { id: 'center-1', stations } ] });

    it('has no center when no file is configured', () => {
        assert.deepEqual(loadLayout(undefined), { centers: [] });
    });

    it('reads the center, with each station\'s stage and lounge', () => {
        const stations = [
            { id: 'intake', lounge: 'lounge-intake', stage: 'intake' },
            { id: 'examination', lounge: 'lounge-examination', stage: 'examination' },
            { id: 'aftercare', lounge: 'lounge-aftercare', stage: 'aftercare' }
        ];

        assert.deepEqual(loadLayout(roomsFile(center(stations))), center(stations));
    });

    it('refuses the format of station rooms, and says why', () => {
        const old = { lounges: [ { room: 'lounge-1' } ], stations: [ { room: 'intake-1', stage: 'intake' } ] };

        assert.throws(() => loadLayout(roomsFile(old)), /ADR 0011/u);
    });

    it('needs exactly one center, for now', () => {
        assert.throws(() => loadLayout(roomsFile({ centers: [] })), /exactly one center/u);
        assert.throws(() => loadLayout(roomsFile({
            centers: [ { id: 'a', stations: [] }, { id: 'b', stations: [] } ]
        })), /exactly one center/u);
    });

    it('refuses a station without a known stage', () => {
        assert.throws(() => loadLayout(roomsFile(center([ { id: 'x', lounge: 'l', stage: 'waiting' } ]))), /stage/u);
    });

    it('refuses a station without an id or a lounge', () => {
        assert.throws(() => loadLayout(roomsFile(center([ { lounge: 'l', stage: 'intake' } ]))), /"id"/u);
        assert.throws(() => loadLayout(roomsFile(center([ { id: 'x', stage: 'intake' } ]))), /"lounge"/u);
    });

    it('refuses two stations with one id, or with one lounge whatever its case', () => {
        assert.throws(() => loadLayout(roomsFile(center([
            { id: 'x', lounge: 'a', stage: 'intake' }, { id: 'x', lounge: 'b', stage: 'aftercare' }
        ]))), /two stations are "x"/u);
        assert.throws(() => loadLayout(roomsFile(center([
            { id: 'x', lounge: 'Lounge', stage: 'intake' }, { id: 'y', lounge: 'lounge', stage: 'aftercare' }
        ]))), /lounge/u);
    });
});

describe('the settings', () => {
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

    it('read the rooms file from COORDINATOR_ROOMS_FILE', () => {
        const file = roomsFile({ centers: [ { id: 'center-1', stations: [] } ] });

        assert.deepEqual(loadConfig(env({ COORDINATOR_ROOMS_FILE: file })).layout, { centers: [ { id: 'center-1', stations: [] } ] });
    });
});
