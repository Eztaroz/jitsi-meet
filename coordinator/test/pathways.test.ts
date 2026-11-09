import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it } from 'node:test';

import { loadLayout } from '../src/config.ts';
import { allStages, resolvePathway, stageName, strandedStages } from '../src/pathways.ts';

/**
 * Writes a rooms file.
 *
 * @param {unknown} content - Its JSON.
 * @returns {string} Its path.
 */
function roomsFile(content: unknown): string {
    const file = join(mkdtempSync(join(tmpdir(), 'pathways-')), 'rooms.json');

    writeFileSync(file, JSON.stringify(content));

    return file;
}

const stage = (id: string, name = id) => ({ id, name });
const SHORT = [ stage('waiting', 'W'), stage('examination', 'E'), stage('done', 'D') ];

const layoutOf = (center: Record<string, unknown>) => loadLayout(roomsFile({ centers: [ { id: 'c1', stations: [], ...center } ] }));

describe('the default pathway', () => {
    it('is waiting, registration, intake, examination, aftercare, billing, pharmacy, done, each with a Thai name', () => {
        const resolved = resolvePathway(layoutOf({}), {});

        assert.ok(!('reason' in resolved));
        assert.deepEqual(resolved.pathway.stages.map(s => s.id),
            [ 'waiting', 'registration', 'intake', 'examination', 'aftercare', 'billing', 'pharmacy', 'done' ]);
        assert.ok(resolved.pathway.stages.every(s => (/[฀-๿]/u).test(s.name)));
    });

    it('is used when no layout is configured at all', () => {
        const resolved = resolvePathway({ centers: [] }, {});

        assert.ok(!('reason' in resolved));
        assert.equal(resolved.pathway.id, 'default');
        assert.equal(resolved.center, undefined);
    });
});

describe('resolving an encounter\'s pathway', () => {
    const layout = layoutOf({
        clinics: [ { id: 'gyn', pathway: 'short' }, { id: 'med' } ],
        pathway: 'center-own',
        pathways: [ { id: 'short', stages: SHORT }, { id: 'center-own', stages: [ stage('waiting'), stage('done') ] } ]
    });

    it('is the clinic\'s, else the center\'s', () => {
        const clinic = resolvePathway(layout, { clinic: 'gyn' });
        const noOwn = resolvePathway(layout, { clinic: 'med' });
        const centerOnly = resolvePathway(layout, {});

        assert.ok(!('reason' in clinic) && !('reason' in noOwn) && !('reason' in centerOnly));
        assert.equal(clinic.pathway.id, 'short');
        assert.equal(noOwn.pathway.id, 'center-own');
        assert.equal(centerOnly.pathway.id, 'center-own');
        assert.equal(centerOnly.center, 'c1');
    });

    it('is the default when neither names one', () => {
        const resolved = resolvePathway(layoutOf({ clinics: [ { id: 'med' } ] }), { clinic: 'med' });

        assert.ok(!('reason' in resolved));
        assert.equal(resolved.pathway.id, 'default');
    });

    it('refuses an unknown center or clinic', () => {
        assert.deepEqual(resolvePathway(layout, { center: 'nope' }), { reason: 'unknown_center' });
        assert.deepEqual(resolvePathway(layout, { clinic: 'nope' }), { reason: 'unknown_clinic' });
        assert.deepEqual(resolvePathway(layout, { center: 'c1', clinic: 'nope' }), { reason: 'unknown_clinic' });
    });
});

describe('the pathways in the rooms file', () => {
    it('must start with waiting and end with done', () => {
        assert.throws(() => layoutOf({ pathways: [ { id: 'p', stages: [ stage('intake'), stage('done') ] } ] }), /waiting/u);
        assert.throws(() => layoutOf({ pathways: [ { id: 'p', stages: [ stage('waiting'), stage('intake') ] } ] }), /done/u);
    });

    it('refuse a stage twice, or without a name', () => {
        assert.throws(() => layoutOf({
            pathways: [ { id: 'p', stages: [ stage('waiting'), stage('x'), stage('x'), stage('done') ] } ]
        }), /"x"/u);
        assert.throws(() => layoutOf({
            pathways: [ { id: 'p', stages: [ stage('waiting'), { id: 'x' }, stage('done') ] } ]
        }), /name/u);
    });

    it('refuse a center or clinic that names a pathway that does not exist', () => {
        assert.throws(() => layoutOf({ pathway: 'ghost' }), /ghost/u);
        assert.throws(() => layoutOf({ clinics: [ { id: 'a', pathway: 'ghost' } ] }), /ghost/u);
    });

    it('let a station serve any stage of a pathway but waiting and done', () => {
        const stations = [ { id: 'reg', lounge: 'lounge-reg', stage: 'registration' } ];

        assert.equal(layoutOf({ stations }).centers[0].stations[0].stage, 'registration');
        assert.throws(() => layoutOf({ stations: [ { id: 'x', lounge: 'l', stage: 'billing-typo' } ] }), /stage/u);
    });
});

describe('the stages of a configuration', () => {
    const layout = layoutOf({ pathways: [ { id: 'default', stages: SHORT } ] });

    it('are named by the pathway, and by their id when no longer configured', () => {
        assert.equal(stageName(layout, 'default', 'examination'), 'E');
        assert.equal(stageName(layout, 'default', 'billing'), 'billing');
        assert.equal(stageName(layout, 'gone', 'waiting'), 'waiting');
    });

    it('are listed once, the default pathway\'s first', () => {
        const mixed = layoutOf({
            pathways: [ { id: 'extra', stages: [ stage('waiting'), stage('lab', 'Lab'), stage('done') ] } ]
        });
        const ids = allStages(mixed).map(s => s.id);

        assert.deepEqual(ids, [ 'waiting', 'registration', 'intake', 'examination', 'aftercare', 'billing', 'pharmacy', 'lab', 'done' ]);
    });

    it('count the open encounters left in a stage the pathway no longer has', () => {
        const open = [
            { pathway: 'default', stage: 'billing' }, { pathway: 'default', stage: 'billing' },
            { pathway: 'default', stage: 'examination' }, { pathway: 'default', stage: 'done' }
        ];

        assert.deepEqual(strandedStages(layout, open), [ { count: 2, stage: 'billing' } ]);
        assert.deepEqual(strandedStages(layoutOf({}), open), []);
    });
});
