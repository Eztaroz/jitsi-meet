import { execFileSync } from 'node:child_process';
import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
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
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'When the recorder bot does not open a closed destination within the coordinator service\'s prepare \
wait (COORDINATOR_PREPARE_WAIT_SECONDS, shortened in the test deployment), the move fails with \
recorder_bot_not_ready, the participant is never sent, and they stay where they are. The destination is the \
patient\'s own room, closed after they went to a station. The recorder bot is made unable to open the room by \
pausing its container before the move back, so run this spec alone: other specs that record a room would stall \
meanwhile. Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment \
with the coordinator service on top of it and RECORDER_BOT_CONTAINER is set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

/**
 * Pauses or resumes the recorder bot's container.
 *
 * @param {'pause'|'unpause'} action - What to do.
 * @returns {void}
 */
function docker(action: 'pause' | 'unpause'): void {
    execFileSync('docker', [ action, config.recorderBot.container ?? '' ], { stdio: 'pipe' });
}

describe('Coordinator: the recorder bot does not open the destination in time', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let patient: Participant;
    let paused = false;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable || !config.recorderBot.container) {
            ctx.skipSuiteTests = unavailable ?? 'RECORDER_BOT_CONTAINER is not set';

            return;
        }

        hn = uniqueHn('PREP');
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
        await waitForRoom(
            r => r === undefined || !r.open || r.occupants.length === 0, hn, 'their room closed', 120_000);
    });

    it('fails the move back with recorder_bot_not_ready, and the participant stays in the station', async () => {
        const station = (await getRooms()).find(r => r.name === 'intake-1')!;
        const endpoint = station.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;

        docker('pause');
        paused = true;

        try {
            const { body } = await postMove('intake-1', endpoint, hn.toLowerCase());

            expect(body.state).toBe('preparing');

            // The wait is shortened in the test deployment; the move fails when it runs out.
            await waitForMove(body.id, 'failed', 60_000);

            const failed = await (await callCoordinator(`/moves/${body.id}`)).json() as { reason?: string; };

            expect(failed.reason).toBe('recorder_bot_not_ready');

            // The participant was never sent: no countdown notice, and they are where they were.
            expect(await (await patient.driver.$('#coordinator-move-cancel')).isExisting()).toBe(false);
            expect(await patient.isInMuc()).toBe(true);
            expect(await patient.driver.getUrl()).not.toContain(encodeURIComponent(hn));
        } finally {
            docker('unpause');
            paused = false;
        }
    });

    after(() => {
        // Never leave the recorder bot paused for the specs that follow.
        if (paused) {
            docker('unpause');
        }
    });
});
