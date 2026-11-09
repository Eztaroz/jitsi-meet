import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    coordinatorUnavailableReason,
    getAudit,
    postEncounter,
    postStage,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A staff member in a station\'s lounge presses "next patient" and is moved into the room of the \
longest-waiting patient of their station\'s stage. With nobody waiting the service answers that the queue is empty \
and the staff member stays in the lounge. The call is audited with the staff member. Skipped unless the deployment \
is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: staff call the next patient', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let encounterId: string;
    let hn: string;
    let staff: Participant;
    let staffJwt: string;

    const lounge = 'lounge-intake';
    const callNext = () => fetch(`${config.coordinator.apiUrl}/staff/next`, {
        headers: { 'Authorization': `Bearer ${staffJwt}`, 'Content-Type': 'application/json' },
        method: 'POST'
    });

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('CALLNEXT');
        encounterId = (await postEncounter(hn)).body.id;
        staffJwt = generateToken({
            displayName: staffIdentity.name,
            userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
        }).jwt;

        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        staff = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: staffIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
            })
        }, { roomName: lounge });
    });

    it('shows "next patient" to staff in the lounge, and says the queue is empty when nobody waits', async () => {
        await (await staff.driver.$('#staff-next-patient')).waitForExist({ timeout: 15_000 });

        const response = await callNext();

        expect(response.status).toBe(409);
        expect(((await response.json()) as { error: string; }).error).toBe('queue_empty');

        await (await staff.driver.$('#staff-next-patient')).click();
        await (await staff.driver.$('#staff-next-message')).waitForExist({ timeout: 15_000 });
        expect(await staff.driver.getUrl()).toContain(lounge);
    });

    it('moves the staff member to the patient waiting for their station', async () => {
        await postStage(encounterId, 'intake');
        await (await staff.driver.$('#staff-next-patient')).click();

        await waitForRoom(r => r?.occupants.some(o => o.role === 'staff'), hn, 'the staff member to reach the patient');
        await staff.driver.waitUntil(async () => !(await staff.driver.getUrl()).includes(lounge), {
            timeout: 30_000,
            timeoutMsg: 'the staff member was not moved to the patient'
        });
    });

    it('audits the call with the staff member and the encounter', async () => {
        const entry = (await getAudit()).find(e => e.kind === 'call_next' && e.encounterId === encounterId
            && e.issuer === staffIdentity.id && e.outcome === 'ok');

        expect(entry).toBeDefined();
    });
});
