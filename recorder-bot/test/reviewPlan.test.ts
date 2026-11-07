import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { type IReviewManifest, planReview } from '../src/reviewPlan.ts';

const START = '2026-11-02T16:00:00.000Z';

/**
 * Returns the ISO time `seconds` after the consultation started.
 *
 * @param {number} seconds - Offset from the start.
 * @returns {string}
 */
function at(seconds: number): string {
    return new Date(Date.parse(START) + seconds * 1000).toISOString();
}

interface ITestIdentity {
    id: string;

    /** One entry per join: when it joined and left, in seconds from the start. */
    joins: Array<{ from: number; to: number; }>;
    role?: 'patient' | 'staff';
}

/**
 * Builds the manifest of a consultation that lasts `length` seconds. Each join is its own endpoint with a video file
 * and an audio file that last as long as the join.
 *
 * @param {number} length - The consultation's length in seconds.
 * @param {ITestIdentity[]} identities - Who was there, in the order they first joined.
 * @param {Array<{ from: number; to: number; }>} gaps - The stretches the bot did not record.
 * @returns {IReviewManifest}
 */
function recording(
        length: number,
        identities: ITestIdentity[],
        gaps: Array<{ from: number; to: number; }> = []
): IReviewManifest {
    const files: IReviewManifest['files'] = [];

    return {
        start: START,
        end: at(length),
        participants: [],
        identities: identities.map(({ id, joins, role }) => ({
            endpointIds: joins.map((_, i) => `${id}-${i}`),
            files: joins.flatMap((join, i) => [ 'video', 'audio' ].map(kind => {
                const name = `${id}-${i}-${kind}.webm`;

                files.push({
                    bytes: 1000,
                    duration: join.to - join.from,
                    endpointId: `${id}-${i}`,
                    kind: kind as 'audio' | 'video',
                    name,
                    start: at(join.from),
                    stop: at(join.to)
                });

                return name;
            })),
            identity: { id, name: `Name ${id}` },
            role: role ?? 'staff'
        })),
        files,
        gaps: gaps.map(gap => ({ start: at(gap.from), end: at(gap.to) }))
    };
}

describe('planReview', () => {
    test('puts two participants side by side on a 1280x720 canvas', () => {
        const plan = planReview(recording(60, [
            { id: 'nurse', joins: [ { from: 0, to: 60 } ] },
            { id: 'patient', joins: [ { from: 1, to: 60 } ], role: 'patient' }
        ]));

        assert.deepEqual(plan.canvas, { width: 1280, height: 720 });
        assert.deepEqual(plan.tiles.map(t => ({ ...t.area, id: t.identity.id })), [
            { x: 0, y: 0, width: 640, height: 720, id: 'nurse' },
            { x: 640, y: 0, width: 640, height: 720, id: 'patient' }
        ]);
    });
    test('keeps a participant who left and came back in one tile, empty in between', () => {
        const plan = planReview(recording(60, [
            { id: 'nurse', joins: [ { from: 0, to: 20 }, { from: 40, to: 60 } ] }
        ]));

        assert.equal(plan.tiles.length, 1);
        assert.deepEqual(plan.tiles[0].video, [
            { file: 'nurse-0-video.webm', from: 0, to: 20 },
            { file: 'nurse-1-video.webm', from: 40, to: 60 }
        ]);
        assert.deepEqual(plan.tiles[0].audio.map(s => s.file), [ 'nurse-0-audio.webm', 'nurse-1-audio.webm' ]);
        assert.deepEqual(plan.tiles[0].empty, [ { from: 20, to: 40 } ]);
    });

    test('leaves the start empty for a late joiner and the end empty for one who left early', () => {
        const plan = planReview(recording(60, [
            { id: 'nurse', joins: [ { from: 0, to: 50 } ] },
            { id: 'patient', joins: [ { from: 5, to: 60 } ], role: 'patient' }
        ]));

        assert.deepEqual(plan.tiles.map(t => t.empty), [ [ { from: 50, to: 60 } ], [ { from: 0, to: 5 } ] ]);
    });

    test('gives a file with no media no span', () => {
        const manifest = recording(60, [ { id: 'nurse', joins: [ { from: 0, to: 60 } ] } ]);
        const video = manifest.files.find(f => f.kind === 'video');

        assert.ok(video);
        video.bytes = 0;
        video.duration = null;

        const [ tile ] = planReview(manifest).tiles;

        assert.deepEqual(tile.video, []);
        assert.deepEqual(tile.empty, [ { from: 0, to: 60 } ]);
        assert.equal(tile.audio.length, 1);
    });

    test('reports each gap as a stretch that no tile has recorded, and the clock to show', () => {
        const plan = planReview(recording(60, [
            { id: 'nurse', joins: [ { from: 0, to: 30 }, { from: 40, to: 60 } ] }
        ], [ { from: 30, to: 40 } ]));

        assert.deepEqual(plan.gaps, [ { from: 30, to: 40 } ]);
        assert.equal(plan.start, '2026-11-02T16:00:00.000Z');
        assert.equal(plan.length, 60);
    });

    test('fills a grid of ceil(sqrt(n)) columns from left to right, row by row', () => {
        const people = (n: number) => Array.from({ length: n }, (_, i) => ({ id: `p${i}`, joins: [ { from: 0, to: 60 } ] }));
        const places = (n: number) => planReview(recording(60, people(n))).tiles.map(t => [ t.area.x, t.area.y, t.area.width, t.area.height ]);

        assert.deepEqual(places(3), [ [ 0, 0, 640, 360 ], [ 640, 0, 640, 360 ], [ 0, 360, 640, 360 ] ]);
        assert.deepEqual(places(4), [ [ 0, 0, 640, 360 ], [ 640, 0, 640, 360 ], [ 0, 360, 640, 360 ], [ 640, 360, 640, 360 ] ]);
        assert.deepEqual(places(5).map(p => p.slice(0, 2)), [ [ 0, 0 ], [ 426, 0 ], [ 852, 0 ], [ 0, 360 ], [ 426, 360 ] ]);
        assert.equal(places(9).length, 9);
        assert.deepEqual(places(9)[8], [ 852, 480, 426, 240 ]);
    });

    test('cuts a file back to the consultation when it starts before or ends after it', () => {
        const manifest = recording(60, [ { id: 'nurse', joins: [ { from: -5, to: 70 } ] } ]);
        const plan = planReview(manifest);

        assert.deepEqual(plan.tiles[0].video, [ { file: 'nurse-0-video.webm', from: 0, to: 60 } ]);
        assert.deepEqual(plan.tiles[0].empty, []);
    });

    test('plans an empty canvas when nobody has an identity', () => {
        const plan = planReview(recording(60, []));

        assert.deepEqual(plan.tiles, []);
        assert.equal(plan.length, 60);
    });
});
