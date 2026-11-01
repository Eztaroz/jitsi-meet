import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadLayout } from '../src/config.ts';

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
