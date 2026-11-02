/**
 * Plans a Review file: one video of a whole consultation, every participant side by side.
 *
 * The plan is a pure function of a finalised evidence recording's manifest. It says where each participant goes on
 * the canvas, which recorded files fill their tile and when, and which stretches are not recorded. Rendering it with
 * ffmpeg is a separate step.
 */

import type { IIdentity, Role, TrackKind } from './consultationLifecycle.ts';

/** The width and height of every Review file's canvas. */
export const CANVAS = { height: 720, width: 1280 } as const;

/** What the plan reads from a manifest.json, as it is on disk: times are ISO 8601 strings. */
export interface IReviewManifest {
    end: string;
    files: Array<{
        bytes: number;

        /** Null when the file could not be read back, or was never written because no media arrived. */
        duration: number | null;
        endpointId: string;
        kind: TrackKind;
        name: string;
        start: string;
        stop?: string;
    }>;
    gaps: Array<{ end: string; start: string; }>;
    identities: Array<{
        endpointIds: string[];
        files: string[];
        identity: IIdentity;
        role: Role;
    }>;
    participants: unknown[];
    start: string;
}

/** Where a tile is on the canvas, in pixels. */
export interface IArea {
    height: number;
    width: number;
    x: number;
    y: number;
}

/** A stretch of the consultation, in seconds from its start. */
export interface ISpan {
    from: number;
    to: number;
}

/** A stretch of the consultation that a recorded file fills. */
export interface IMediaSpan extends ISpan {
    file: string;
}

export interface IReviewTile {
    area: IArea;
    audio: IMediaSpan[];

    /** The stretches without video, which the tile shows as black. */
    empty: ISpan[];
    identity: IIdentity;
    role: Role;
    video: IMediaSpan[];
}

export interface IReviewPlan {
    canvas: typeof CANVAS;

    /** The stretches the recorder bot did not record, which every tile shows as not recorded. */
    gaps: ISpan[];

    /** How long the consultation lasted, in seconds. */
    length: number;

    /** When the consultation started, as ISO 8601: the wall-clock time at second 0. */
    start: string;
    tiles: IReviewTile[];
}

/**
 * Returns the stretches of [0, total] that the spans leave uncovered.
 *
 * @param {ISpan[]} spans - Spans in order of start, which do not overlap.
 * @param {number} total - The end of the consultation.
 * @returns {ISpan[]}
 */
function uncovered(spans: ISpan[], total: number): ISpan[] {
    const result: ISpan[] = [];
    let cursor = 0;

    for (const span of spans) {
        if (span.from > cursor) {
            result.push({ from: cursor, to: span.from });
        }
        cursor = Math.max(cursor, span.to);
    }

    return cursor < total ? [ ...result, { from: cursor, to: total } ] : result;
}

/**
 * Plans a Review file.
 *
 * @param {IReviewManifest} manifest - The evidence recording's manifest.
 * @returns {IReviewPlan}
 */
export function planReview(manifest: IReviewManifest): IReviewPlan {
    const origin = Date.parse(manifest.start);
    const seconds = (time: string) => (Date.parse(time) - origin) / 1000;
    const total = seconds(manifest.end);
    const within = (offset: number) => Math.min(Math.max(offset, 0), total);
    const byName = new Map(manifest.files.map(file => [ file.name, file ]));

    /**
     * Returns the spans of an identity's files of one kind, in order of start. A file with no media has no span.
     *
     * @param {string[]} names - The identity's files.
     * @param {TrackKind} kind - Audio or video.
     * @returns {IMediaSpan[]}
     */
    const spansOf = (names: string[], kind: TrackKind): IMediaSpan[] => names
        .flatMap(name => {
            const file = byName.get(name);

            return file?.kind === kind && file.bytes > 0 && file.duration !== null
                ? [ { file: name, from: within(seconds(file.start)), to: file.stop ? within(seconds(file.stop)) : total } ]
                : [];
        })
        .sort((a, b) => a.from - b.from);

    const columns = Math.max(1, Math.ceil(Math.sqrt(manifest.identities.length)));
    const rows = Math.ceil(manifest.identities.length / columns);
    const width = Math.floor(CANVAS.width / columns);
    const height = Math.floor(CANVAS.height / rows);

    return {
        canvas: CANVAS,
        gaps: manifest.gaps.map(gap => ({ from: within(seconds(gap.start)), to: within(seconds(gap.end)) })),
        length: total,
        start: manifest.start,
        tiles: manifest.identities.map(({ files, identity, role }, index) => {
            const video = spansOf(files, 'video');

            return {
                area: { height, width, x: (index % columns) * width, y: Math.floor(index / columns) * height },
                audio: spansOf(files, 'audio'),
                empty: uncovered(video, total),
                identity,
                role,
                video
            };
        })
    };
}
