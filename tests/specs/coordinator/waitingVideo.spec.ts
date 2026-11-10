import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { coordinatorUnavailableReason, postEncounter, screenUrl, waitForRoom } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator plays a waiting patient\'s default video from the screen and stops it again. The video \
player joins the patient\'s own room as a visible participant of its own role, and the patient\'s client gives no menu \
on its tile, so the patient cannot stop, mute or hide it. Skipped unless the deployment is the JWT variant of the \
recorder bot\'s test deployment with the coordinator service and the video player on top of it \
(VIDEO_PLAYER_AVAILABLE=true), and its web server sets videoPlayerMarker.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: a waiting video from the screen', () => {
    const coordinator = { id: `coordinator-${uuidv4()}`, name: 'ผู้ประสานงาน' };
    let hn: string;
    let encounterId: string;
    let patient: Participant;
    let screen: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason()
            ?? (process.env.VIDEO_PLAYER_AVAILABLE === 'true' ? undefined : 'VIDEO_PLAYER_AVAILABLE is not true');

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }
        hn = uniqueHn('VIDEO');
        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: 'Patient V',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        encounterId = (await postEncounter(hn)).body.id;

        // The deployment needs a token to join any room, even a scratch one for the browser the screen runs in.
        screen = await joinMuc({ name: 'p2', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(generateToken({
            displayName: coordinator.name,
            userClaims: { hospital_role: 'coordinator', id: coordinator.id }
        }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
    });

    const toggle = () => screen.driver.$(`.queue-entry[data-encounter="${encounterId}"]`).parentElement()
        .$('.video-toggle');

    it('plays the stage\'s default video into the patient\'s room as the video player', async () => {
        await (await toggle()).click();
        await waitForRoom(room => Boolean(room?.occupants.some(o => o.role === 'video_player')), hn,
            'the video player in the patient\'s room');
        await patient.waitForParticipants(1);
    });

    it('gives the patient no menu on the video player\'s tile', async () => {
        // The only remote participant is the video player; its tile has no "remote user controls" button.
        expect(await patient.driver.$('[aria-label*="emote user controls"]').isExisting()).toBe(false);
    });

    it('stops the video from the screen', async () => {
        await (await toggle()).click();
        await waitForRoom(room => !room?.occupants.some(o => o.role === 'video_player'), hn,
            'the video player gone from the patient\'s room');
    });
});
