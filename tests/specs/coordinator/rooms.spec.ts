import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    callCoordinator,
    coordinatorUnavailableReason,
    postEncounter,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn, waitForHiddenParticipant } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The coordinator service lists the open rooms and who is in them: each occupant\'s verified \
identity and role (patient or staff, from the role markers), the recorder bot as hidden, and the room is gone once \
it closes. The API refuses a call without the bearer secret. Skipped unless the deployment is the JWT variant of the \
recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: open rooms and their occupants', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    let hn: string;
    let patient: Participant;
    let staff: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('ROOMS');
        expect((await postEncounter(hn)).status).toBe(201);

        const room = patientLinkRoom(hn);

        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: room });
        staff = await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: staffIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
            })
        }, { roomName: room });
        await waitForHiddenParticipant(patient);
    });

    it('refuses a request without the right bearer secret', async () => {
        expect((await callCoordinator('/rooms', {}, '')).status).toBe(401);
        expect((await callCoordinator('/rooms', {}, 'wrong')).status).toBe(401);
    });

    it('lists the room with the patient, the staff member and the hidden recorder bot', async () => {
        const room = await waitForRoom(r => r?.occupants.length === 3, hn, 'the patient, staff and the bot');
        const roles = Object.fromEntries(room!.occupants.map(o => [ o.identity?.id ?? o.role, o.role ]));

        expect(roles[patientIdentity.id]).toBe('patient');
        expect(roles[staffIdentity.id]).toBe('staff');
        expect(room!.occupants.filter(o => o.role === 'hidden').length).toBe(1);
        expect(room!.occupants.find(o => o.identity?.id === patientIdentity.id)?.identity?.name)
            .toBe(patientIdentity.name);
        expect(room!.occupants.every(o => o.endpointId.length > 0)).toBe(true);
    });

    it('gives the endpoint id the participants have themselves', async () => {
        const room = await waitForRoom(r => r?.occupants.length === 3, hn, 'all occupants');
        const ids = room!.occupants.map(o => o.endpointId);

        expect(ids).toContain(await patient.getEndpointId());
        expect(ids).toContain(await staff.getEndpointId());
    });

    it('drops the room once the meeting has ended', async () => {
        await patient.getToolbar().clickEndMeetingForAllButton();
        await waitForRoom(r => r === undefined, hn, 'the room to close', 60_000);
    });
});
