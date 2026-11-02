import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    postMove,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A moved participant can cancel during the countdown: they stay in their room and the move ends as \
cancelled. A second move of someone whose move is still under way is refused as already being moved, and the first \
is unaffected. A message that looks like a move command but comes from another participant moves nobody. Skipped \
unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top \
of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: cancelled, conflicting and forged moves', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let lounge: string;
    let staff: Participant;
    let patient: Participant;
    let staffEndpoint: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('CANCEL');
        lounge = `lounge-${uuidv4()}`;

        patient = await joinMuc({
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
        staffEndpoint = await staff.getEndpointId();
        await waitForRoom(r => r?.occupants.length === 1, hn, 'the patient in their room');
    });

    it('ignores a move command that comes from another participant', async () => {
        const forged = JSON.stringify({
            countdownSeconds: 5,
            destination: hn.toLowerCase(),
            moveId: 'forged',
            token: 'not-a-token',
            type: 'coordinator_move'
        });

        await patient.execute((json: string) => APP.conference._room.room.sendMessage(json, 'json-message'), forged);
        await staff.driver.pause(7_000);

        expect(await (await staff.driver.$('#coordinator-move-notice')).isExisting()).toBe(false);
        expect(await staff.driver.getUrl()).toContain(lounge);
    });

    let firstMove: string;

    it('refuses a second move of someone whose move is under way, and the first is unaffected', async () => {
        const first = await postMove(lounge, staffEndpoint, hn.toLowerCase());

        expect(first.body.state).toBe('counting_down');
        firstMove = first.body.id;

        const second = await postMove(lounge, staffEndpoint, hn.toLowerCase());

        expect(second.body.state).toBe('refused');
        expect(second.body.reason).toBe('already_being_moved');

        await (await staff.driver.$('#coordinator-move-notice')).waitForExist({ timeout: 10_000 });
    });

    it('tells the participant the unit of the countdown', async () => {
        // The countdown counts down from 5 to 1; the text must read "in N seconds…".
        expect(await (await staff.driver.$('#coordinator-move-notice')).getText())
            .toMatch(/^You are being moved to another room in [1-5] seconds…/u);
    });

    it('stays in the room and ends the move as cancelled when the participant cancels', async () => {
        await (await staff.driver.$('#coordinator-move-cancel')).click();
        await waitForMove(firstMove, 'cancelled', 15_000);

        // The countdown would have ended by now.
        await staff.driver.pause(6_000);
        expect(await staff.driver.getUrl()).toContain(lounge);
        expect(await (await staff.driver.$('#coordinator-move-notice')).isExisting()).toBe(false);
    });
});
