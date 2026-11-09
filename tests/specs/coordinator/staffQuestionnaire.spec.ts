import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    coordinatorUnavailableReason,
    getAudit,
    getQuestionnaires,
    postEncounter,
    postMove,
    waitForMove
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A staff member sends a health questionnaire to a patient and reads the answers from inside the \
patient\'s own room. Staff in a lounge, or in another patient\'s room, can neither send nor read, and each sending is \
audited with the staff member. Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment \
with the coordinator service on top of it, and its coordinator configuration has the "lifestyle" questionnaire of \
coordinator/test-deployment/rooms.json.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: staff send questionnaires and read the answers', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    let encounterId: string;
    let hn: string;
    let lounge: string;
    let patient: Participant;
    let staff: Participant;
    let staffJwt: string;

    const staffCall = (route: string, init: RequestInit = {}) =>
        fetch(`${config.coordinator.apiUrl}/staff${route}`, {
            ...init,
            headers: { 'Authorization': `Bearer ${staffJwt}`, 'Content-Type': 'application/json' }
        });
    const sendFromApi = (questionnaire: string) => staffCall(`/encounters/${encounterId}/questionnaires`,
        { body: JSON.stringify({ questionnaire }), method: 'POST' });

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('STAFFQ');
        lounge = 'lounge-intake';
        encounterId = (await postEncounter(hn)).body.id;
        staffJwt = generateToken({
            displayName: staffIdentity.name,
            userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
        }).jwt;

        patient = await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: 'Patient P',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        staff = await joinMuc({ name: 'p1', token: generateToken({
            displayName: staffIdentity.name,
            userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
        }) }, { roomName: lounge });
    });

    it('refuses staff who are not in the patient\'s room, for sending and for reading', async () => {
        const sent = await sendFromApi('lifestyle');

        expect(sent.status).toBe(403);
        expect(((await sent.json()) as { error: string; }).error).toBe('not_in_patients_room');
        expect((await staffCall(`/encounters/${encounterId}/questionnaires`)).status).toBe(403);
        expect(await getQuestionnaires(encounterId)).toEqual([]);
    });

    it('sends from the panel in the patient\'s room, and shows the patient\'s answers there', async () => {
        const move = await postMove(lounge, await staff.getEndpointId(), hn.toLowerCase());

        await waitForMove(move.body.id, 'done');
        await staff.driver.waitUntil(() => staff.isInMuc(), { timeout: 30_000, timeoutMsg: 'not in the patient\'s room' });

        await (await staff.driver.$('#staff-questionnaire-picker')).waitForExist({ timeout: 15_000 });
        await (await staff.driver.$('#staff-questionnaire-picker')).selectByAttribute('value', 'lifestyle');
        await (await staff.driver.$('#staff-questionnaire-send')).click();

        await patient.driver.$('#coordinator-questionnaire').waitForDisplayed({ timeout: 15_000 });
        await patient.driver.$('#coordinator-questionnaire-0-0').click();
        await patient.driver.$('#coordinator-questionnaire-1-0').click();
        await patient.driver.$('#coordinator-questionnaire-submit').click();

        const answers = await staff.driver.$('#staff-questionnaire-answers');

        await answers.waitForExist({ timeout: 15_000 });
        await staff.driver.waitUntil(async () => (await answers.getText()).includes('Do you smoke?'), {
            timeout: 15_000,
            timeoutMsg: 'the staff member does not see the patient\'s answers'
        });
    });

    it('audits the sending with the staff member', async () => {
        const entry = (await getAudit()).find(e => e.kind === 'questionnaire_sent' && e.encounterId === encounterId
            && e.issuer === staffIdentity.id);

        expect(entry?.outcome).toBe('ok');
        expect(entry?.questionnaire).toBe('lifestyle');
    });
});
