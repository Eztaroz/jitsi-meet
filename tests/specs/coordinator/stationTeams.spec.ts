import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    postEncounter,
    postMove,
    screenUrl,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The coordinator screen shows each station as a team: a staff member waiting in the station\'s \
lounge is listed as free; once the coordinator moves them into a patient\'s room they are listed as busy with that \
patient, and the patient is shown at the station rather than only in the queue of their stage; when they are moved \
back to the lounge they are free again and the patient is back in the queue. The screen follows without a reload. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3' ]
});

describe('Coordinator: stations as teams on the screen', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Team Staff' };
    const lounge = 'lounge-aftercare';
    let hn: string;
    let screen: Participant;
    let staff: Participant;
    let staffEndpoint: string;

    /**
     * Returns the text of the team of the aftercare station, as the screen shows it.
     *
     * @returns {Promise<string>}
     */
    async function teamText(): Promise<string> {
        return (await screen.driver.$('.team[data-station="aftercare"]')).getText();
    }

    /**
     * Returns the text of the patient's entry in the queues.
     *
     * @returns {Promise<string>}
     */
    async function ticketText(): Promise<string> {
        return screen.driver.execute((room: string) => Array.from(document.querySelectorAll<HTMLElement>('.queue-entry'))
            .find(e => e.innerText.includes(room))?.innerText ?? '', hn);
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('TEAM');
        expect((await postEncounter(hn)).status).toBe(201);

        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: 'Patient T',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        staff = await joinMuc({
            name: 'p3',
            token: generateToken({
                displayName: staffIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
            })
        }, { roomName: lounge });
        staffEndpoint = await staff.getEndpointId();

        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(generateToken({
            displayName: 'Coordinator T',
            userClaims: { hospital_role: 'coordinator', id: `coordinator-${uuidv4()}` }
        }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
    });

    it('lists the staff member in the lounge as free', async () => {
        await screen.driver.waitUntil(async () => (await teamText()).includes(staffIdentity.name),
            { timeout: 15_000, timeoutMsg: 'the staff member is not on their station\'s team' });
        expect(await teamText()).toContain('ว่าง 1');
        expect(await teamText()).toContain('ไม่ว่าง 0');
    });

    it('lists them as busy with the patient once they are in the patient\'s room, and shows the patient at the station', async () => {
        const { body } = await postMove(lounge, staffEndpoint, hn.toLowerCase());

        await waitForMove(body.id, 'done');
        await waitForRoom(r => r?.occupants.some(o => o.role === 'staff'), hn, 'the staff member in the patient\'s room');
        await screen.driver.waitUntil(async () => (await teamText()).includes(`กับ ${hn}`),
            { timeout: 15_000, timeoutMsg: 'the staff member is not shown as busy with the patient' });
        expect(await teamText()).toContain('ว่าง 0');
        expect(await teamText()).toContain('ไม่ว่าง 1');
        await screen.driver.waitUntil(async () => (await ticketText()).includes('อยู่ที่ aftercare'),
            { timeout: 15_000, timeoutMsg: 'the patient is not shown at the station' });
    });

    it('lists them as free again, and the patient back in the queue, once they are back in the lounge', async () => {
        const { body } = await postMove(hn.toLowerCase(), await staff.getEndpointId(), lounge);

        await waitForMove(body.id, 'done');
        await screen.driver.waitUntil(async () => (await teamText()).includes('ว่าง 1'),
            { timeout: 15_000, timeoutMsg: 'the staff member is not free again' });
        expect(await teamText()).toContain('ไม่ว่าง 0');
        expect(await ticketText()).not.toContain('อยู่ที่');
    });
});
