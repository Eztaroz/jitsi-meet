import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { coordinatorUnavailableReason } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The deployment has neither the welcome page nor a close page, so a participant who leaves a room \
lands on static/left.html rather than staying on a meeting that looks frozen. A participant who hangs up is told \
that they have left and offered to rejoin the room with the same token; once a staff member has ended the meeting \
for everyone, it says that the consultation has ended, with nothing to rejoin. A patient, and only a patient, is \
asked the satisfaction survey there, which the coordinator service keeps. Skipped unless the deployment is the JWT \
variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

const LEFT_PAGE = '/static/left.html';

/**
 * Waits until a participant is on the left page, and returns its title.
 *
 * @param {Participant} participant - Who left.
 * @returns {Promise<string>}
 */
async function waitForLeftPage(participant: Participant): Promise<string> {
    await participant.driver.waitUntil(async () => (await participant.driver.getUrl()).includes(LEFT_PAGE), {
        timeout: 15_000,
        timeoutMsg: `${participant.name} did not land on ${LEFT_PAGE}`
    });
    const title = participant.driver.$('#left-title');

    await title.waitForDisplayed();

    return title.getText();
}

describe('Coordinator: the page a participant lands on once they have left', () => {
    const patientToken = () => generateToken({
        displayName: 'Patient P',
        userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
    });
    const staffToken = () => generateToken({
        displayName: 'Staff S',
        userClaims: { ...expectations.recorderBot.staffClaims, id: `staff-${uuidv4()}` }
    });

    it('setup', () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    it('takes a patient who hangs up to the left page, where they can answer the survey', async () => {
        const room = patientLinkRoom(uniqueHn('SURVEY'));
        const patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });

        await patient.getToolbar().clickHangupButton();
        expect(await waitForLeftPage(patient)).toBe('You have left the room');

        const $ = (selector: string) => patient.driver.$(selector);

        await $('#left-survey').waitForDisplayed({ timeout: 10_000 });
        await $('[data-rating="2"]').click();
        await $('[data-tag="sound"]').click();
        await $('[data-action="details"]').click();
        await $('[data-aspect="quality"][data-level="2"]').click();
        await $('#sv-comment').setValue('The sound kept cutting out.');
        await $('[data-action="send"]').click();
        await $('.sv-thanks').waitForDisplayed({ timeout: 10_000 });
    });

    it('takes a patient who hangs up to the left page, from which they can rejoin the room', async () => {
        const room = patientLinkRoom(uniqueHn('LEFT'));
        const patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });

        await patient.getToolbar().clickHangupButton();
        expect(await waitForLeftPage(patient)).toBe('You have left the room');

        const rejoin = patient.driver.$('#left-rejoin');

        await rejoin.waitForDisplayed();
        await rejoin.click();
        await patient.waitToJoinMUC();
        expect(new URL(await patient.driver.getUrl()).pathname.toLowerCase()).toBe(`/${room.toLowerCase()}`);
    });

    it('tells everyone that the consultation has ended once a staff member has ended the meeting for everyone, and \
asks only the patient the survey', async () => {
        const room = patientLinkRoom(uniqueHn('ENDED'));
        const patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });
        const staff = await joinMuc({ name: 'p2', token: staffToken() }, { roomName: room });

        await staff.driver.waitUntil(() => staff.isModerator(), { timeout: 15_000 });
        await staff.getToolbar().clickEndMeetingForAllButton();

        for (const participant of [ patient, staff ]) {
            const ok = participant.driver.$('#modal-dialog-ok-button');

            await ok.waitForDisplayed({ timeout: 15_000 });
            await ok.click();
            expect(await waitForLeftPage(participant)).toBe('The consultation has ended');
            expect(await participant.driver.$('#left-rejoin').isDisplayed()).toBe(false);
        }
        await patient.driver.$('#left-survey').waitForDisplayed({ timeout: 10_000 });

        // The page asks the coordinator service before it shows the survey: give the staff member's page the time the
        // patient's took.
        await staff.driver.pause(3000);
        expect(await staff.driver.$('#left-survey').isExisting()).toBe(false);
    });
});
