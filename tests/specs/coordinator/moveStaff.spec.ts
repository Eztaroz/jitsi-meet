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
    description: 'The coordinator moves a staff member from a lounge into an open patient\'s room: the staff \
member\'s page shows a notice with a countdown that does not name the destination, then enters the destination \
without the prejoin page and with the microphone and camera as they were, using a token for the destination only. \
The move is done once they are there. A move of someone who is not there, or to a room that is not open, is refused. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: move a staff member', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let lounge: string;
    let staff: Participant;
    let staffEndpoint: string;
    let moveId: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('MOVE');
        lounge = `lounge-${uuidv4()}`;

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
        staffEndpoint = await staff.getEndpointId();

        // The microphone is muted, so a move that forgot it would unmute it.
        await staff.getToolbar().clickAudioMuteButton();
        await staff.driver.waitUntil(
            () => staff.execute(() => APP.store.getState()['features/base/media'].audio.muted),
            { timeoutMsg: 'the microphone was not muted' });

        await waitForRoom(r => r?.occupants.length === 1, hn, 'the patient in their room');
    });

    it('refuses to move someone who is not there, and a move to a room that is not open', async () => {
        const nobody = await postMove(lounge, 'nobody', hn.toLowerCase());

        expect(nobody.body.state).toBe('refused');
        expect(nobody.body.reason).toBe('participant_not_found');

        const closed = await postMove(lounge, staffEndpoint, `closed-${uuidv4()}`);

        expect(closed.body.state).toBe('refused');
        expect(closed.body.reason).toBe('destination_not_open');
    });

    it('starts the move and shows a notice with a countdown that does not name the destination', async () => {
        const { body, status } = await postMove(lounge, staffEndpoint, hn.toLowerCase());

        expect(status).toBe(202);
        expect(body.state).toBe('counting_down');
        moveId = body.id;

        const notice = await staff.driver.$('#coordinator-move-notice');

        await notice.waitForExist({ timeout: 10_000 });

        const text = await notice.getText();

        expect(text).toMatch(/moved to another room/u);
        expect(text.toLowerCase()).not.toContain('lounge');
        expect(text.toLowerCase()).not.toContain(hn.toLowerCase());
    });

    it('enters the destination without the prejoin page, and the move is done', async () => {
        await waitForMove(moveId, 'done');
        await staff.driver.waitUntil(() => staff.isInMuc(), { timeout: 30_000, timeoutMsg: 'not in the destination' });

        const room = await waitForRoom(r => r?.occupants.length === 2, hn, 'the staff member in the patient\'s room');

        expect(room!.occupants.some(o => o.identity?.id === staffIdentity.id && o.role === 'staff')).toBe(true);
        expect(await staff.driver.getUrl()).toContain(encodeURIComponent(hn.toLowerCase()));
    });

    it('keeps the microphone muted, as it was', async () => {
        expect(await staff.execute(() => APP.store.getState()['features/base/media'].audio.muted)).toBe(true);
    });

    it('joined with a token for the destination only', async () => {
        const jwt = await staff.execute(() => APP.store.getState()['features/base/jwt'].jwt as string);
        const claims = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());

        expect(claims.iss).toBe('coordinator');
        expect(claims.room).toBe(encodeURIComponent(hn.toLowerCase()).toLowerCase());
        expect(claims.room).not.toBe('*');
    });
});
