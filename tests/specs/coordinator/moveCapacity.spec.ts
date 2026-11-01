import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    callCoordinator,
    coordinatorUnavailableReason,
    getRooms,
    postMove,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, postConsultation, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'When the recorder bot is at capacity, a move of a patient back to their own room, which is closed, \
fails with its reason, and the patient stays where they are. This test fills the recorder bot, so run it alone: other specs \
that record a room would be refused meanwhile. Skipped unless the deployment is the JWT variant of the recorder bot\'s \
test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: the recorder bot is at capacity', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let patient: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('CAP');
        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        await waitForRoom(r => r?.occupants.length === 1, hn, 'the patient');
        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: 'Nurse N',
                userClaims: { ...expectations.recorderBot.staffClaims, id: `nurse-${uuidv4()}` }
            })
        }, { roomName: 'intake-1' });

        // A patient may be moved only into a station or their own room: go to the station, and let their room close.
        const room = await waitForRoom(r => r?.occupants.length === 1, hn, 'the patient');
        const { body } = await postMove(hn.toLowerCase(), room!.occupants[0].endpointId, 'intake-1');

        await waitForMove(body.id, 'done');

        // The 60-second rule closes their room (ADR 0006).
        await waitForRoom(r => r === undefined || !r.open || r.occupants.length === 0, hn, 'their room closed', 120_000);
    });

    it('fails the move, and leaves the patient where they are', async () => {
        // Fill the recorder bot's consultations; they end by themselves, nobody being in their rooms.
        for (let i = 0; i < 20; i++) {
            if ((await postConsultation(uniqueHn(`FILL${i}`))).status === 503) {
                break;
            }
        }

        const station = (await getRooms()).find(r => r.name === 'intake-1')!;
        const endpoint = station.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;
        const { body } = await postMove('intake-1', endpoint, hn.toLowerCase());

        expect(body.state).toBe('preparing');
        await waitForMove(body.id, 'failed', 30_000);

        const failed = await (await callCoordinator(`/moves/${body.id}`)).json() as { reason?: string; };

        expect(failed.reason).toBe('recorder_bot_at_capacity');
        expect(await patient.isInMuc()).toBe(true);
        expect(await patient.driver.getUrl()).not.toContain(encodeURIComponent(hn));

        // The consultations that filled the recorder bot end by themselves; let them, for the specs that follow.
        await patient.driver.pause(25_000);
    });
});
