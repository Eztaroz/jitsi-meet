import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { IQuestionnaire } from '../src/questionnaires.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const SMOKING: IQuestionnaire = {
    id: 'lifestyle',
    questions: [
        { choices: [ 'Yes', 'No' ], text: 'Do you smoke?' },
        { choices: [ 'Yes', 'No' ], text: 'Do you drink?' }
    ],
    title: 'Lifestyle'
};
const PAIN: IQuestionnaire = {
    id: 'pain',
    questions: [ { choices: [ 'Yes', 'No' ], text: 'Does it hurt?' } ],
    title: 'Pain'
};
const LAYOUT: ILayout = {
    centers: [ { id: 'c1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ] } ],
    questionnaires: [ SMOKING, PAIN ]
};

const occupant = (role: string, id: string, endpointId: string) =>
    ({ endpointId, hidden: false, identity: { user: { hospital_role: role, id, name: id } } });

describe('health questionnaires, through the coordinator service', () => {
    let dir: string;
    let service: CoordinatorService;
    let store: Store;
    let retentionMs = 90 * 24 * 3600_000;

    /** The occupants of the patient\'s room, which the fake Prosody reports. */
    let occupants: ReturnType<typeof occupant>[];

    /**
     * Starts a service over the store in the directory, as the process does.
     *
     * @returns {CoordinatorService}
     */
    function boot(): CoordinatorService {
        store = new Store(dir);

        return new CoordinatorService({
            auditKey: 'audit-key',
            layout: LAYOUT,
            prosody: { rooms: async () => ({ rooms: [ { name: 'HN1', occupants } ] }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
    }

    /**
     * Starts an encounter.
     *
     * @param {string} hn - The HN.
     * @returns {Promise<string>} The encounter's id.
     */
    async function encounter(hn = 'HN1'): Promise<string> {
        return (await service.startEncounter(hn)).encounter?.id as string;
    }

    beforeEach(() => {
        dir = mkdtempSync(join(tmpdir(), 'questionnaire-'));
        occupants = [ occupant('patient', 'p-1', 'e-pat') ];
        retentionMs = 90 * 24 * 3600_000;
        service = boot();
    });

    afterEach(() => {
        service.stop();
        store.close();
    });

    it('sends a configured questionnaire to a patient with an open encounter, and audits who sent it', async () => {
        const id = await encounter();
        const { sent } = await service.sendQuestionnaire(id, 'lifestyle', 'coord-1');

        assert.ok(sent);
        assert.deepEqual(service.questionnairesOf(id)?.map(q => q.id), [ sent.id ]);

        const entry = service.audit(10).find(e => e.kind === 'questionnaire_sent');

        assert.equal(entry?.issuer, 'coord-1');
        assert.equal(entry?.encounterId, id);
        assert.equal(entry?.questionnaire, 'lifestyle');
        assert.equal(entry?.outcome, 'ok');
    });

    it('refuses an unknown questionnaire, an unknown encounter and a closed one, and audits the refusal', async () => {
        const id = await encounter();

        assert.equal((await service.sendQuestionnaire(id, 'nope', 'coord-1')).refused, 'unknown_questionnaire');
        assert.equal((await service.sendQuestionnaire('missing', 'pain', 'coord-1')).refused, 'unknown_encounter');
        await service.changeStage(id, 'done', 'system');
        assert.equal((await service.sendQuestionnaire(id, 'pain', 'coord-1')).refused, 'encounter_closed');
        assert.equal(service.audit(10).filter(e => e.kind === 'questionnaire_sent' && e.outcome === 'refused').length, 3);
        assert.deepEqual(service.questionnairesOf(id), []);
    });

    it('shows the patient what was sent, with no answers and nothing about staff', async () => {
        const id = await encounter();

        assert.equal(await service.pendingQuestionnaire('p-1'), undefined);

        const { sent } = await service.sendQuestionnaire(id, 'lifestyle', 'coord-1');
        const pending = await service.pendingQuestionnaire('p-1');

        assert.deepEqual(pending, { id: sent?.id, questions: SMOKING.questions, title: 'Lifestyle' });
        assert.equal(await service.pendingQuestionnaire('someone-else'), undefined);
    });

    it('keeps the answers with the encounter, and shows the next questionnaire once one is answered', async () => {
        const id = await encounter();
        const first = (await service.sendQuestionnaire(id, 'lifestyle', 'coord-1')).sent;
        const second = (await service.sendQuestionnaire(id, 'pain', 'coord-1')).sent;

        assert.deepEqual(await service.answerQuestionnaire('p-1', first?.id as string, [ 1, 0 ]), {});
        assert.equal((await service.pendingQuestionnaire('p-1'))?.id, second?.id);
        assert.deepEqual(await service.answerQuestionnaire('p-1', second?.id as string, [ 0 ]), {});
        assert.equal(await service.pendingQuestionnaire('p-1'), undefined);

        const kept = service.questionnairesOf(id) ?? [];

        assert.deepEqual(kept.map(q => [ q.questionnaire, q.answers ]), [ [ 'lifestyle', [ 1, 0 ] ], [ 'pain', [ 0 ] ] ]);
    });

    it('keeps questionnaires of different encounters apart', async () => {
        const a = await encounter('HN1');
        const b = await encounter('HN2');

        await service.sendQuestionnaire(a, 'pain', 'coord-1');

        assert.equal(service.questionnairesOf(a)?.length, 1);
        assert.deepEqual(service.questionnairesOf(b), []);
    });

    it('refuses answers that do not fit the questions, an answer twice and an answer from another patient', async () => {
        const id = await encounter();
        const sent = (await service.sendQuestionnaire(id, 'lifestyle', 'coord-1')).sent?.id as string;

        assert.equal((await service.answerQuestionnaire('p-1', sent, [ 1 ])).refused, 'invalid_answers');
        assert.equal((await service.answerQuestionnaire('p-1', sent, [ 1, 2 ])).refused, 'invalid_answers');
        assert.equal((await service.answerQuestionnaire('p-1', sent, 'yes')).refused, 'invalid_answers');
        assert.equal((await service.answerQuestionnaire('p-2', sent, [ 1, 0 ])).refused, 'unknown_questionnaire');
        assert.equal((await service.answerQuestionnaire('p-1', 'missing', [ 1, 0 ])).refused, 'unknown_questionnaire');
        assert.deepEqual(await service.answerQuestionnaire('p-1', sent, [ 1, 0 ]), {});
        assert.equal((await service.answerQuestionnaire('p-1', sent, [ 0, 0 ])).refused, 'unknown_questionnaire');
        assert.deepEqual(service.questionnairesOf(id)?.[0].answers, [ 1, 0 ]);
    });

    it('closes when a staff member joins the room after it was sent', async () => {
        const id = await encounter();

        await service.sendQuestionnaire(id, 'pain', 'coord-1');
        assert.ok(await service.pendingQuestionnaire('p-1'));

        occupants.push(occupant('staff', 's-1', 'e-staff'));

        assert.equal(await service.pendingQuestionnaire('p-1'), undefined);

        // It stays closed after the staff member leaves, and holds nobody up.
        occupants.pop();
        assert.equal(await service.pendingQuestionnaire('p-1'), undefined);
        assert.equal(service.questionnairesOf(id)?.[0].answers, undefined);
        assert.ok(service.questionnairesOf(id)?.[0].closedAt);
    });

    it('stays when the staff member who sent it is already in the room', async () => {
        const id = await encounter();

        occupants.push(occupant('staff', 's-1', 'e-staff'));
        await service.sendQuestionnaire(id, 'pain', 's-1');

        assert.ok(await service.pendingQuestionnaire('p-1'));
    });

    it('keeps the questionnaires and answers across a restart', async () => {
        const id = await encounter();
        const sent = (await service.sendQuestionnaire(id, 'pain', 'coord-1')).sent?.id as string;

        await service.answerQuestionnaire('p-1', sent, [ 1 ]);
        await service.sendQuestionnaire(id, 'lifestyle', 'coord-1');
        service.stop();
        store.close();
        service = boot();

        const kept = service.questionnairesOf(id) ?? [];

        assert.deepEqual(kept.map(q => [ q.questionnaire, q.answers ]), [ [ 'pain', [ 1 ] ], [ 'lifestyle', undefined ] ]);
        assert.ok(kept[0].answeredAt instanceof Date);
        assert.equal((await service.pendingQuestionnaire('p-1'))?.title, 'Lifestyle');
    });

    it('deletes them with the encounter in the retention sweep', async () => {
        const id = await encounter();

        await service.sendQuestionnaire(id, 'pain', 'coord-1');
        service.stop();
        store.close();
        retentionMs = -60_000;
        service = boot();
        service.startRetention();
        await new Promise(resolve => setTimeout(resolve, 50));

        assert.equal(service.questionnairesOf(id), undefined);
        assert.equal(new Store(dir).load().encounters.length, 0);
    });

    it('lists the catalogue without exposing anything else', () => {
        assert.deepEqual(service.questionnaireCatalogue().map(q => [ q.id, q.title, q.questions.length ]),
            [ [ 'lifestyle', 'Lifestyle', 2 ], [ 'pain', 'Pain', 1 ] ]);
    });
});
