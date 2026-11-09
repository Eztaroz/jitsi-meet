/**
 * Renders a Review file from a finalised evidence recording, following the plan from reviewPlan.ts.
 *
 * A Review file is for people to watch. It is not evidence, it is not kept, and it can always be made again, so the
 * evidence recording is only ever read: the render never writes into its folder, and refuses an output path inside it.
 */
import { execFile } from 'node:child_process';
import { copyFile, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';

import { readManifest } from './evidence.ts';
import { errorCode } from './log.ts';
import { type IReviewManifest, type IReviewPlan, type ISpan, planReview } from './reviewPlan.ts';

const execFileAsync = promisify(execFile);

const FRAME_RATE = 25;
const SAMPLE_RATE = 48000;

/** What every tile reads during a gap. */
const NOT_RECORDED = 'not recorded';

/** Why a Review file could not be made, in words for the person who ran the command. */
export class ReviewError extends Error {
    override name = 'ReviewError';
}

/** The ffmpeg run that renders a plan. */
export interface IReviewJob {

    /** The arguments to ffmpeg, which runs in a work folder that holds the font and the text files. */
    args: string[];

    /** The text files drawtext reads, by name in the work folder. */
    texts: Record<string, string>;
}

/**
 * Formats a number of seconds for a filter graph.
 *
 * @param {number} seconds - Seconds.
 * @returns {string}
 */
function sec(seconds: number): string {
    return seconds.toFixed(3);
}

/**
 * Escapes text for drawtext's expansion, and keeps it on one line. Display names are typed by participants.
 *
 * @param {string} text - The text.
 * @returns {string}
 */
function literal(text: string): string {
    return text.replace(/\s+/g, ' ').replace(/[\\%]/g, match => `\\${match}`);
}

/**
 * Returns a timeline expression that is true during any of the spans.
 *
 * @param {ISpan[]} spans - The spans.
 * @returns {string}
 */
function during(spans: ISpan[]): string {
    return spans.map(span => `between(t,${sec(span.from)},${sec(span.to)})`).join('+');
}

/**
 * Returns the parts of the spans that no gap covers.
 *
 * @param {ISpan[]} spans - Spans in order of start.
 * @param {ISpan[]} gaps - The gaps.
 * @returns {ISpan[]}
 */
export function outsideGaps(spans: ISpan[], gaps: ISpan[]): ISpan[] {
    return gaps.reduce((rest, gap) => rest.flatMap(span => [
        { from: span.from, to: Math.min(span.to, gap.from) },
        { from: Math.max(span.from, gap.to), to: span.to }
    ].filter(part => part.to > part.from)), spans);
}

/**
 * Builds the ffmpeg run that renders a plan: every tile's video overlaid on a black canvas, a black canvas during the
 * gaps, each tile's label with the wall-clock time, and every participant's audio mixed into one track.
 *
 * @param {IReviewPlan} plan - The plan.
 * @param {Object} options - Options.
 * @param {string} options.folder - The evidence recording's folder, which holds the media files.
 * @param {string} options.font - The font file's name in the work folder.
 * @param {string} options.output - Where to write the MP4.
 * @returns {IReviewJob}
 */
export function reviewJob(plan: IReviewPlan, { folder, font, output }: {
    folder: string;
    font: string;
    output: string;
}): IReviewJob {
    const inputs: string[] = [];
    const graph: string[] = [];
    const texts: Record<string, string> = {};
    const epoch = Date.parse(plan.start) / 1000;
    const length = sec(plan.length);
    let video = 'canvas';
    let step = 0;

    /**
     * Adds a filter to the video chain.
     *
     * @param {string} filter - The filter, with its inputs after the chain's current output.
     * @param {string} [extra] - Further input pads, such as an overlaid tile.
     * @returns {void}
     */
    const chain = (filter: string, extra = '') => {
        step += 1;
        graph.push(`[${video}]${extra}${filter}[v${step}]`);
        video = `v${step}`;
    };

    /**
     * Adds a text file and returns its name.
     *
     * @param {string} text - What it holds, already escaped for drawtext.
     * @returns {string}
     */
    const textFile = (text: string) => {
        const name = `text-${Object.keys(texts).length}.txt`;

        texts[name] = text;

        return name;
    };

    /**
     * Draws text on the canvas.
     *
     * @param {string} file - The text file.
     * @param {Object} where - Where, as drawtext expressions, and how big.
     * @param {string} [enable] - When, as a timeline expression; always when omitted.
     * @returns {void}
     */
    const draw = (file: string, where: { size: number; x: string; y: string; }, enable?: string) => chain([
        `drawtext=fontfile=${font}:textfile=${file}:fontcolor=white:fontsize=${where.size}`,
        `x=${where.x}:y=${where.y}:box=1:boxcolor=black@0.6:boxborderw=6`,
        ...enable ? [ `enable='${enable}'` ] : []
    ].join(':'));

    graph.push(`color=c=black:s=${plan.canvas.width}x${plan.canvas.height}:r=${FRAME_RATE}:d=${length}[canvas]`);

    for (const tile of plan.tiles) {
        const { height, width, x, y } = tile.area;

        for (const span of tile.video) {
            const input = inputs.push(path.join(folder, span.file)) - 1;

            graph.push(`[${input}:v]setpts=PTS-STARTPTS,trim=duration=${sec(span.to - span.from)},`
                + `setpts=PTS+${sec(span.from)}/TB,`
                + `scale=${width}:${height}:force_original_aspect_ratio=decrease:force_divisible_by=2,`
                + `pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:color=black,setsar=1[t${input}]`);
            chain(`overlay=x=${x}:y=${y}:eof_action=pass:enable='${during([ span ])}'`, `[t${input}]`);
        }
    }

    if (plan.gaps.length) {
        chain(`drawbox=x=0:y=0:w=iw:h=ih:color=black:t=fill:enable='${during(plan.gaps)}'`);
    }

    for (const tile of plan.tiles) {
        const { height, width, x, y } = tile.area;
        const name = literal(tile.identity.name || tile.identity.id);
        const label = Math.max(12, Math.round(height / 22));
        const centre = Math.max(16, Math.round(height / 12));
        const middle = { size: centre, x: `${x}+(${width}-tw)/2`, y: `${y}+(${height}-th)/2` };
        const empty = outsideGaps(tile.empty, plan.gaps);

        if (empty.length) {
            draw(textFile(name), middle, during(empty));
        }
        if (plan.gaps.length) {
            draw(textFile(NOT_RECORDED), middle, during(plan.gaps));
        }
        draw(textFile(`${name} (${tile.role})  %{pts:localtime:${epoch.toFixed(3)}:%H\\:%M\\:%S}`), {
            size: label,
            x: `${x}+${label}`,
            y: `${y}+${height}-th-${label}`
        });
    }

    graph.push(`anullsrc=r=${SAMPLE_RATE}:cl=stereo,atrim=duration=${length}[silence]`);

    const voices = plan.tiles.flatMap(tile => tile.audio).map(span => {
        const input = inputs.push(path.join(folder, span.file)) - 1;

        graph.push(`[${input}:a]asetpts=PTS-STARTPTS,atrim=duration=${sec(span.to - span.from)},`
            + `aresample=${SAMPLE_RATE}:async=1,aformat=channel_layouts=stereo,`
            + `adelay=delays=${Math.round(span.from * 1000)}:all=1[a${input}]`);

        return `[a${input}]`;
    });

    graph.push(`[silence]${voices.join('')}amix=inputs=${voices.length + 1}:duration=first:normalize=0[audio]`);

    return {
        args: [
            '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
            ...inputs.flatMap(input => [ '-i', input ]),
            '-filter_complex', graph.join(';'),
            '-map', `[${video}]`, '-map', '[audio]',
            '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-r', String(FRAME_RATE),
            '-c:a', 'aac', '-b:a', '128k',
            '-t', length, '-movflags', '+faststart', '-f', 'mp4', output
        ],
        texts
    };
}

/**
 * Finds a font that has Thai and Latin glyphs, with fontconfig.
 *
 * @returns {Promise<string>} The font file.
 */
async function findFont(): Promise<string> {
    try {
        const { stdout } = await execFileAsync('fc-match', [ '--format=%{file}', 'sans:lang=th' ]);

        if (stdout.trim()) {
            return stdout.trim();
        }
    } catch {
        // Below.
    }
    throw new ReviewError('no font found with fontconfig; pass one with --font <file>');
}

/**
 * Whether `inner` is `outer` or inside it.
 *
 * @param {string} outer - A folder.
 * @param {string} inner - A path.
 * @returns {boolean}
 */
function isWithin(outer: string, inner: string): boolean {
    const relative = path.relative(outer, inner);

    return !relative.startsWith('..') && !path.isAbsolute(relative);
}

/**
 * Reads a finalised evidence recording's manifest.
 *
 * @param {string} folder - The evidence recording's folder.
 * @returns {Promise<IReviewManifest>}
 */
async function readReviewManifest(folder: string): Promise<IReviewManifest> {
    if (!await stat(folder).then(s => s.isDirectory(), () => false)) {
        throw new ReviewError('the evidence recording folder does not exist');
    }

    let finalised;

    try {
        finalised = await readManifest(folder);
    } catch (error) {
        throw new ReviewError(`the evidence recording's manifest cannot be read (${errorCode(error)})`);
    }
    if (!finalised) {
        throw new ReviewError('the folder is not a finalised evidence recording: it has no manifest.json');
    }

    const manifest = JSON.parse(await readFile(path.join(folder, 'manifest.json'), 'utf8')) as IReviewManifest;

    if (Number.isNaN(Date.parse(manifest.end)) || !Array.isArray(manifest.files)
            || !Array.isArray(manifest.identities) || !Array.isArray(manifest.gaps)) {
        throw new ReviewError('the evidence recording\'s manifest is malformed');
    }

    return manifest;
}

/**
 * Renders a Review file of a finalised evidence recording.
 *
 * @param {Object} options - Options.
 * @param {string} options.folder - The evidence recording's folder.
 * @param {string} options.output - Where to write the MP4; not inside the evidence recording's folder.
 * @param {string} [options.font] - A font file with Thai and Latin glyphs; found with fontconfig when omitted.
 * @returns {Promise<IReviewPlan>} The plan it rendered.
 */
export async function renderReview({ folder, font, output }: {
    folder: string;
    font?: string;
    output: string;
}): Promise<IReviewPlan> {
    const manifest = await readReviewManifest(folder);
    const evidence = await realpath(folder);
    const target = path.join(
        await realpath(path.dirname(path.resolve(output))).catch(() => {
            throw new ReviewError('the output file\'s folder does not exist');
        }),
        path.basename(output));

    if (isWithin(evidence, target)) {
        throw new ReviewError('the output file is inside the evidence recording folder; the evidence is never written to');
    }

    const plan = planReview(manifest);
    const media = plan.tiles
        .flatMap(tile => [ ...tile.video, ...tile.audio ])
        .map(span => span.file);

    for (const file of media) {
        if (!await stat(path.join(evidence, file)).then(s => s.isFile(), () => false)) {
            throw new ReviewError(`the evidence recording is missing a media file: ${file}`);
        }
    }

    const fontFile = font ?? await findFont();
    const work = await mkdtemp(path.join(os.tmpdir(), 'review-'));
    const partial = `${target}.part`;

    try {
        await copyFile(fontFile, path.join(work, `font${path.extname(fontFile)}`)).catch(() => {
            throw new ReviewError('the font file cannot be read');
        });

        const job = reviewJob(plan, { folder: evidence, font: `font${path.extname(fontFile)}`, output: partial });

        for (const [ name, text ] of Object.entries(job.texts)) {
            await writeFile(path.join(work, name), text);
        }

        try {
            await execFileAsync('ffmpeg', job.args, { cwd: work, maxBuffer: 16 * 1024 * 1024 });
        } catch (error) {
            const detail = (error as { stderr?: string; }).stderr?.trim() || errorCode(error);

            throw new ReviewError(`ffmpeg could not render the Review file: ${detail}`);
        }
        await rename(partial, target);
    } finally {
        await rm(partial, { force: true });
        await rm(work, { force: true, recursive: true });
    }

    return plan;
}
