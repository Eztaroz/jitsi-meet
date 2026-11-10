import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { coordinatorUnavailableReason } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'Staff cannot end a patient\'s own room or take the patient out of it, since either would end the \
consultation mid-encounter (ADR 0011, 0012). In a patient\'s room the client hides "end meeting for all" from staff, \
and kick for the patient, while mute stays; Prosody refuses the same three (end for everyone, kick, demote to a \
visitor) when a modified client sends them anyway. In a room without a patient, staff moderation is unchanged. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it, and its web server sets patientMarker.',
    usesBrowsers: [ 'p1', 'p2' ]
});

// How long a refused request is given to show up, had it not been refused: Prosody answers it at once.
const SETTLE_MS = 3000;
// The hangup button is wrapped in a dialog only when it is a menu; Toolbox does not pass its aria-controls on.
const HANGUP_MENU = '//div[contains(@class, "toolbox-button-wth-dialog")]//*[@aria-label="Leave the meeting"]';

describe('Coordinator: staff cannot end, kick or demote in a patient\'s room', () => {
    const patientToken = () => generateToken({
        displayName: 'Patient P',
        userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
    });
    const staffToken = () => generateToken({
        displayName: 'Staff S',
        userClaims: { ...expectations.recorderBot.staffClaims, id: `staff-${uuidv4()}` }
    });

    let patient: Participant;
    let staff: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    describe('in a patient\'s own room', () => {
        it('setup', async () => {
            const room = patientLinkRoom(uniqueHn('NOKICK'));

            patient = await joinMuc({ name: 'p1', token: patientToken() }, { roomName: room });
            staff = await joinMuc({ name: 'p2', token: staffToken() }, { roomName: room });
            await staff.driver.waitUntil(() => staff.isModerator(), { timeout: 15_000 });
            await staff.waitForParticipants(1);
        });

        it('shows staff no "end meeting for all"', async () => {
            // The hangup is a menu only for a moderator who can end the meeting.
            expect(await staff.driver.$(HANGUP_MENU).isExisting()).toBe(false);
        });

        it('shows staff no kick for the patient, and keeps mute', async () => {
            const patientId = await patient.getEndpointId();

            expect(await staff.getFilmstrip().remoteMenuHasLink(patientId, 'mutelink')).toBe(true);
            expect(await staff.getFilmstrip().remoteMenuHasLink(patientId, 'kicklink')).toBe(false);
            expect(await staff.getFilmstrip().remoteMenuHasLink(patientId, 'demotelink')).toBe(false);
        });

        it('refuses a kick sent by a modified client', async () => {
            const patientId = await patient.getEndpointId();

            await staff.execute((id: string) => APP.conference._room.kickParticipant(id), patientId);
            await patient.driver.pause(SETTLE_MS);
            expect(await patient.isInMuc()).toBe(true);
            expect(await patient.getEndpointId()).toBe(patientId);
        });

        it('refuses a demote to a visitor sent by a modified client', async () => {
            const patientId = await patient.getEndpointId();
            const staffId = await staff.getEndpointId();

            await staff.execute((id: string, actor: string) => APP.conference._room.sendMessage({
                type: 'visitors',
                action: 'demote-request',
                id,
                actor
            }), patientId, staffId);
            await patient.driver.pause(SETTLE_MS);
            expect(await patient.isInMuc()).toBe(true);
            expect(await patient.getEndpointId()).toBe(patientId);
        });

        it('refuses the end of the meeting for everyone, sent by a modified client', async () => {
            await staff.execute(() => APP.conference._room.end());
            await patient.driver.pause(SETTLE_MS);
            expect(await patient.isInMuc()).toBe(true);
            expect(await staff.isInMuc()).toBe(true);
        });
    });

    describe('in a room without a patient', () => {
        it('leaves staff moderation unchanged', async () => {
            const room = patientLinkRoom(uniqueHn('LOUNGE'));

            staff = await joinMuc({ name: 'p1', token: staffToken() }, { roomName: room });
            const other = await joinMuc({ name: 'p2', token: staffToken() }, { roomName: room });

            await staff.driver.waitUntil(() => staff.isModerator(), { timeout: 15_000 });
            await staff.waitForParticipants(1);

            expect(await staff.driver.$(HANGUP_MENU).isExisting()).toBe(true);
            expect(await staff.getFilmstrip().remoteMenuHasLink(await other.getEndpointId(), 'kicklink')).toBe(true);
        });
    });
});
