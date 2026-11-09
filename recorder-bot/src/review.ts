/**
 * The `npm run review` command: renders a Review file of one evidence recording.
 *
 *     npm run review -- [--font <file>] <evidence recording folder> <output file>
 *
 * It needs ffmpeg and ffprobe on PATH, like the service. The Review file is made on request and not stored: it is not
 * evidence. See README.md.
 */
import path from 'node:path';
import { parseArgs } from 'node:util';

import { errorCode } from './log.ts';
import { ReviewError, renderReview } from './reviewRender.ts';

const USAGE = 'usage: npm run review -- [--font <file>] <evidence recording folder> <output file>';

/**
 * Resolves a path the person typed. `npm run` runs the command in this package's folder, so a relative path is
 * resolved against the folder they ran npm from.
 *
 * @param {string} file - The path.
 * @returns {string}
 */
function typed(file: string): string {
    return path.resolve(process.env.INIT_CWD ?? process.cwd(), file);
}

/**
 * Runs the command.
 *
 * @returns {Promise<number>} The exit code.
 */
async function main(): Promise<number> {
    let parsed;

    try {
        parsed = parseArgs({ allowPositionals: true, options: { font: { type: 'string' } } });
    } catch {
        parsed = undefined;
    }
    if (parsed?.positionals.length !== 2) {
        process.stderr.write(`${USAGE}\n`);

        return 2;
    }

    const [ folder, output ] = parsed.positionals.map(typed);

    try {
        const plan = await renderReview({
            folder,
            font: parsed.values.font === undefined ? undefined : typed(parsed.values.font),
            output
        });

        process.stdout.write(`wrote a Review file of ${Math.round(plan.length)} seconds with ${
            plan.tiles.length} participant(s); it is not evidence, delete it when done\n`);

        return 0;
    } catch (error) {
        process.stderr.write(`${error instanceof ReviewError
            ? error.message : `could not make the Review file (${errorCode(error)})`}\n`);

        return 1;
    }
}

process.exitCode = await main();
