import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    coordinatorUnavailableReason,
    getAudit,
    getEncounter,
    postEncounter,
    postMove,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A staff member in a patient\'s own room sees the patient\'s current stage and a picker of every \
stage of the pathway but done, changes the stage, and is moved back to their station\'s lounge. The service takes \
requests only from a hospital-issued token with the staff marker, refuses done for staff and a staff member who is \
not in that patient\'s room, and audits each change with the staff member. Skipped unless the deployment is the JWT \
variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: staff change a patient\'s stage', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let encounterId: string;
    let hn: string;
    let lounge: string;
    let staff: Participant;
    let staffJwt: string;

    const staffCall = (route: string, init: RequestInit = {}, token: string | undefined = staffJwt) =>
        fetch(`${config.coordinator.apiUrl}/staff${route}`, {
            ...init,
            headers: { ...token ? { 'Authorization': `Bearer ${token}` } : {}, 'Content-Type': 'application/json' }
        });
    const postStaffStage = (stage: string, token: string | undefined = staffJwt) =>
        staffCall(`/encounters/${encounterId}/stage`, { body: JSON.stringify({ stage }), method: 'POST' }, token);

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('STAFFSTAGE');
        lounge = 'lounge-intake';
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

    it('refuses a request without a token, and a token that is not a staff member\'s', async () => {
        expect((await postStaffStage('billing', '')).status).toBe(401);

        const patientJwt = generateToken({
            displayName: 'P', userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
        }).jwt;

        expect((await postStaffStage('billing', patientJwt)).status).toBe(403);
        expect((await getEncounter(encounterId)).body.stage).toBe('waiting');
    });

    it('refuses a staff member who is not in that patient\'s room', async () => {
        const response = await postStaffStage('billing');

        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string; }).error).toBe('not_in_patients_room');
        expect((await getEncounter(encounterId)).body.stage).toBe('waiting');
    });

    it('shows staff in the patient\'s room the current stage and every stage but done', async () => {
        const endpointId = await staff.getEndpointId();
        const move = await postMove(lounge, endpointId, hn.toLowerCase());

        await waitForMove(move.body.id, 'done');
        await staff.driver.waitUntil(() => staff.isInMuc(), { timeout: 30_000, timeoutMsg: 'not in the patient\'s room' });

        const panel = await staff.driver.$('#staff-stage-panel');

        await panel.waitForExist({ timeout: 15_000 });
        expect(await (await staff.driver.$('#staff-current-stage')).getText()).toMatch(/รอคิว/u);

        const options = await staff.driver.$$('#staff-stage-picker option');
        const values = await Promise.all(options.map(o => o.getAttribute('value')));

        expect(values).toContain('billing');
        expect(values).toContain('waiting');
        expect(values).not.toContain('done');
    });

    it('refuses done for staff', async () => {
        const response = await postStaffStage('done');

        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string; }).error).toBe('done_is_not_for_staff');
    });

    it('changes the stage from the picker, and moves the staff member back to the lounge', async () => {
        await (await staff.driver.$('#staff-stage-picker')).selectByAttribute('value', 'billing');
        await (await staff.driver.$('#staff-stage-apply')).click();

        await waitForRoom(r => r?.occupants.every(o => o.role !== 'staff'), hn, 'the staff member to leave the patient\'s room');
        await staff.driver.waitUntil(async () => (await staff.driver.getUrl()).includes(lounge), {
            timeout: 30_000,
            timeoutMsg: 'the staff member was not moved back to the lounge'
        });

        expect((await getEncounter(encounterId)).body.stage).toBe('billing');
    });

    it('audits the change with the staff member, the encounter and both stages', async () => {
        const entry = (await getAudit()).find(e => e.kind === 'stage' && e.encounterId === encounterId
            && e.issuer === staffIdentity.id && e.outcome === 'ok');

        expect(entry?.from).toBe('waiting');
        expect(entry?.to).toBe('billing');
    });
});
