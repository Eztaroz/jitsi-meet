import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

const ci = readFileSync(new URL('../../../.gitlab-ci.yml', import.meta.url), 'utf8').replace(/\r\n/gu, '\n');

/**
 * The text of a top-level job of the pipeline file.
 *
 * @param {string} name - The job.
 * @returns {string}
 */
function job(name: string): string {
    const match = new RegExp(`^${name}:\n((?: .*\n|\n)*)`, 'mu').exec(ci);

    assert.ok(match, `the job ${name} exists`);

    return match[1];
}

describe('the night pipeline (ADR 0017)', () => {
    it('deploys the workers, allowing the only recorder bot, in a stage after the rollback', () => {
        const night = job('deploy-workers-night');
        const stages = ci.slice(ci.indexOf('stages:'), ci.indexOf('\n\n', ci.indexOf('stages:'))).split('\n').map(l => l.replace(/^\s*-\s*/u, ''));

        assert.match(night, /ALLOW_SINGLE_RECORDER_BOT: "1"/u);
        assert.match(night, /deployWorkersMain\.ts/u);
        assert.match(night, /- triggers/u);
        assert.ok(stages.indexOf('workers') > stages.indexOf('rollback'), 'a failing worker does not roll the central services back');
        assert.match(night, /stage: workers/u);
    });

    it('is the only job that sets ALLOW_SINGLE_RECORDER_BOT, and the by-push job does not', () => {
        assert.equal(ci.match(/ALLOW_SINGLE_RECORDER_BOT: "1"/gu)?.length, 1);
        assert.ok(!job('deploy-workers').includes('ALLOW_SINGLE_RECORDER_BOT'));
    });
});
