import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    callCoordinator,
    coordinatorUnavailableReason,
    getAudit,
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
    description: 'A staff member in a patient\'s own room chooses the patient\'s waiting video for the stage, plays it and \
stops it from the call. A video the staff member started keeps playing after they leave, and the coordinator can \
stop it. The service refuses a staff member who is not in that patient\'s room, and audits each choice, play and stop \
with who did it. Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the \
coordinator service and the video player on top of it (VIDEO_PLAYER_AVAILABLE=true).',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: staff control a patient\'s waiting video', () => {
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff V' };
    let encounterId: string;
    let hn: string;
    let lounge: string;
    let staff: Participant;
    let staffJwt: string;

    const staffCall = (route: string, body: unknown = {}) =>
        fetch(`${config.coordinator.apiUrl}/staff${route}`, {
            body: JSON.stringify(body),
            headers: { 'Authorization': `Bearer ${staffJwt}`, 'Content-Type': 'application/json' },
            method: 'POST'
        });
    const videoPlayerIn = (present: boolean) => waitForRoom(
        room => Boolean(room?.occupants.some(o => o.role === 'video_player')) === present, hn,
        present ? 'the video player in the patient\'s room' : 'the video player gone from the patient\'s room');

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason()
            ?? (process.env.VIDEO_PLAYER_AVAILABLE === 'true' ? undefined : 'VIDEO_PLAYER_AVAILABLE is not true');

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('STAFFVIDEO');
        lounge = 'lounge-intake';
        encounterId = (await postEncounter(hn)).body.id;
        staffJwt = generateToken({
            displayName: staffIdentity.name,
            userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
        }).jwt;

        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: 'Patient V',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
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

    it('refuses a staff member who is not in the patient\'s room', async () => {
        const response = await staffCall(`/encounters/${encounterId}/video`);

        expect(response.status).toBe(403);
        expect(((await response.json()) as { error: string; }).error).toBe('not_in_patients_room');
    });

    it('shows the video controls to staff in the patient\'s room', async () => {
        const move = await postMove(lounge, await staff.getEndpointId(), hn.toLowerCase());

        await waitForMove(move.body.id, 'done');
        await staff.driver.waitUntil(() => staff.isInMuc(), { timeout: 30_000, timeoutMsg: 'not in the patient\'s room' });
        await (await staff.driver.$('#staff-video-controls')).waitForExist({ timeout: 15_000 });
    });

    it('chooses a video for the stage from the picker', async () => {
        const options = await staff.driver.$$('#staff-video-picker option:not([disabled])');
        const video = await options[options.length - 1].getAttribute('value');

        await (await staff.driver.$('#staff-video-picker')).selectByAttribute('value', video);
        await staff.driver.waitUntil(async () => (await (await staff.driver.$('#staff-video-picker')).getValue()) === video);

        const entry = (await getAudit()).find(e => e.kind === 'video' && e.action === 'choose'
            && e.issuer === staffIdentity.id && e.outcome === 'ok');

        expect(entry?.video).toBe(video);
    });

    it('plays and stops the video from the call', async () => {
        await (await staff.driver.$('#staff-video-play')).click();
        await videoPlayerIn(true);

        await (await staff.driver.$('#staff-video-stop')).click();
        await videoPlayerIn(false);
    });

    it('keeps a video the staff member started playing after they leave', async () => {
        await (await staff.driver.$('#staff-video-play')).click();
        await videoPlayerIn(true);

        await (await staff.driver.$('#staff-stage-picker')).selectByAttribute('value', 'waiting');
        await (await staff.driver.$('#staff-stage-apply')).click();
        await waitForRoom(r => r?.occupants.every(o => o.role !== 'staff'), hn, 'the staff member to leave the patient\'s room');

        // Give the service's polling a few turns to stop it if it were going to.
        await staff.driver.pause(5_000);
        await videoPlayerIn(true);
    });

    it('stops from the coordinator\'s API, and audits every choice, play and stop with who did it', async () => {
        expect((await callCoordinator(`/encounters/${encounterId}/video/stop`, { body: '{}', method: 'POST' })).status).toBe(200);
        await videoPlayerIn(false);

        const entries = (await getAudit()).filter(e => e.kind === 'video' && e.outcome === 'ok');

        expect(entries.some(e => e.action === 'play' && e.issuer === staffIdentity.id)).toBe(true);
        expect(entries.some(e => e.action === 'stop' && e.issuer === staffIdentity.id)).toBe(true);
        expect(entries.some(e => e.action === 'stop' && e.issuer !== staffIdentity.id)).toBe(true);
    });
});
