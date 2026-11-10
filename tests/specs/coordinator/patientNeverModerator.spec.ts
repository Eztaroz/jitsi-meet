import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { coordinatorUnavailableReason } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A patient is never a moderator, wherever they are, while staff are, so that they can end a \
consultation for everyone. Jicofo makes everyone with a token an owner, and the first participant of a room too, so \
the patient joins their own room first. A staff member then joins, becomes a moderator, and \
grants moderator to the patient from the filmstrip, which Prosody\'s muc_patient_never_moderator module refuses. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

// How long a refused grant is given to show up, had it not been refused: Prosody answers it at once.
const GRANT_SETTLE_MS = 3000;

/**
 * Waits until a participant is a moderator.
 *
 * @param {Participant} participant - Who should become one.
 * @returns {Promise<void>}
 */
async function waitForModerator(participant: Participant): Promise<void> {
    await participant.driver.waitUntil(() => participant.isModerator(), {
        timeout: 15_000,
        timeoutMsg: `${participant.name} did not become a moderator`
    });
}

describe('Coordinator: a patient is never a moderator', () => {
    const patientToken = () => generateToken({
        displayName: 'Patient P',
        userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
    });
    const staffToken = () => generateToken({
        displayName: 'Staff S',
        userClaims: { ...expectations.recorderBot.staffClaims, id: `staff-${uuidv4()}` }
    });

    /**
     * Joins the patient first and a staff member after them, then checks the roles, before and after the staff
     * member grants moderator to the patient.
     *
     * @param {string} room - The room, as Prosody names it.
     * @returns {Promise<void>}
     */
    async function checkRoles(room: string): Promise<void> {
        const patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });
        const staff = await joinMuc({ name: 'p2', token: staffToken() }, { roomName: room });

        // Jicofo has granted the roles of both by the time the staff member, who joined last, is a moderator.
        await waitForModerator(staff);
        expect(await patient.isModerator()).toBe(false);

        await staff.getFilmstrip().grantModerator(patient);
        await patient.driver.pause(GRANT_SETTLE_MS);
        expect(await patient.isModerator()).toBe(false);
        expect(await staff.isModerator()).toBe(true);
    }

    it('setup', () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    it('keeps a patient who joins their own room first out of the moderator role', async () => {
        await checkRoles(patientLinkRoom(uniqueHn('NOMOD')));
    });
});
