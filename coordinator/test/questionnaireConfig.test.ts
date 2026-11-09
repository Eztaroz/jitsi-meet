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
    const file = join(mkdtempSync(join(tmpdir(), 'questionnaires-')), 'rooms.json');

    writeFileSync(file, JSON.stringify(content));

    return file;
}

describe('the health questionnaires of the configuration', () => {
    const stations = [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ];
    const withQuestionnaires = (questionnaires: unknown) => ({ centers: [ { id: 'c1', stations } ], questionnaires });
    const question = { choices: [ 'Yes', 'No' ], text: 'Do you smoke?' };
    const valid = { id: 'lifestyle', questions: [ question ], title: 'Lifestyle' };

    it('reads the catalogue', () => {
        assert.deepEqual(loadLayout(roomsFile(withQuestionnaires([ valid ]))).questionnaires, [ valid ]);
    });

    it('is optional', () => {
        assert.equal(loadLayout(roomsFile({ centers: [ { id: 'c1', stations } ] })).questionnaires, undefined);
    });

    it('refuses a question without exactly two choices, and says which questionnaire', () => {
        for (const choices of [ [ 'Yes' ], [ 'Yes', 'No', 'Maybe' ], [], 'Yes/No', [ 'Yes', '' ] ]) {
            assert.throws(() => loadLayout(roomsFile(withQuestionnaires([
                { ...valid, questions: [ { ...question, choices } ] }
            ]))), /questionnaire "lifestyle".*exactly two choices/u);
        }
    });

    it('refuses a questionnaire without an id, a title or questions, and two with one id', () => {
        assert.throws(() => loadLayout(roomsFile(withQuestionnaires([ { ...valid, id: '' } ]))), /"id"/u);
        assert.throws(() => loadLayout(roomsFile(withQuestionnaires([ { ...valid, title: ' ' } ]))), /"title"/u);
        assert.throws(() => loadLayout(roomsFile(withQuestionnaires([ { ...valid, questions: [] } ]))), /questions/u);
        assert.throws(() => loadLayout(roomsFile(withQuestionnaires([ valid, valid ]))), /two questionnaires are "lifestyle"/u);
        assert.throws(() => loadLayout(roomsFile(withQuestionnaires({}))), /must be a list/u);
    });
});
