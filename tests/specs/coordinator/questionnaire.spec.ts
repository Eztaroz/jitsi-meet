import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getQuestionnaires,
    postEncounter,
    postQuestionnaire
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator sends a health questionnaire to a patient with an open encounter. The patient\'s client \
shows it as an overlay over the call, one at a time when several are sent, until they answer it or a staff member joins \
the room after it was sent. The answers are kept with the encounter and read through the API. Skipped unless the \
deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it, and \
its coordinator configuration has the "lifestyle" and "pain" questionnaires of coordinator/test-deployment/rooms.json.',
    usesBrowsers: [ 'p1', 'p2' ]
});

const OVERLAY = '#coordinator-questionnaire';
const SUBMIT = '#coordinator-questionnaire-submit';

describe('Coordinator: health questionnaires', () => {
    const patientToken = () => generateToken({
        displayName: 'Patient P',
        userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
    });
    const staffToken = () => generateToken({
        displayName: 'Staff S',
        userClaims: { ...expectations.recorderBot.staffClaims, id: `staff-${uuidv4()}` }
    });

    let encounterId: string;
    let patient: Participant;
    let room: string;
    let staff: Participant;

    /**
     * Picks the first choice of every question and sends the answers.
     *
     * @param {number} questions - How many questions the questionnaire has.
     * @returns {Promise<void>}
     */
    async function answer(questions: number): Promise<void> {
        for (let i = 0; i < questions; i++) {
            await patient.driver.$(`#coordinator-questionnaire-${i}-0`).click();
        }
        await patient.driver.$(SUBMIT).click();
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn('QUEST');

        room = patientLinkRoom(hn);
        encounterId = (await postEncounter(hn)).body.id;
        patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });
    });

    it('refuses an unknown questionnaire and an unknown encounter', async () => {
        expect((await postQuestionnaire(encounterId, 'nope')).status).toBe(400);
        expect((await postQuestionnaire('nope', 'pain')).status).toBe(404);
    });

    it('shows the patient the questionnaire over the call, the oldest first, and keeps their answers', async () => {
        expect((await postQuestionnaire(encounterId, 'lifestyle')).status).toBe(201);
        expect((await postQuestionnaire(encounterId, 'pain')).status).toBe(201);

        await patient.driver.$(OVERLAY).waitForDisplayed({ timeout: 15_000 });
        expect(await patient.driver.$(OVERLAY).getText()).toContain('Do you smoke?');

        await answer(2);

        // The second one follows once the first is answered.
        await patient.driver.waitUntil(async () => (await patient.driver.$(OVERLAY).getText()).includes('Does it hurt today?'),
            { timeout: 15_000 });
        await answer(1);
        await patient.driver.$(OVERLAY).waitForDisplayed({ reverse: true, timeout: 15_000 });

        const kept = await getQuestionnaires(encounterId);

        expect(kept.map(q => [ q.questionnaire, q.answers ])).toEqual([ [ 'lifestyle', [ 0, 0 ] ], [ 'pain', [ 0 ] ] ]);
    });

    it('closes the overlay without an answer when a staff member joins after it was sent', async () => {
        const sent = await postQuestionnaire(encounterId, 'pain');

        expect(sent.status).toBe(201);
        await patient.driver.$(OVERLAY).waitForDisplayed({ timeout: 15_000 });

        staff = await joinMuc({ name: 'p2', token: staffToken() }, { roomName: room });
        await patient.driver.$(OVERLAY).waitForDisplayed({ reverse: true, timeout: 15_000 });

        const closed = (await getQuestionnaires(encounterId)).find(q => q.id === sent.body.id);

        expect(closed?.answers).toBeUndefined();
        expect(closed?.closedAt).toBeDefined();
        expect(staff).toBeDefined();
    });
});
