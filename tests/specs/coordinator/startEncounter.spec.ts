import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    callCoordinator,
    coordinatorLogs,
    coordinatorUnavailableReason,
    getEncounter,
    postEncounter,
    restartCoordinator
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn, waitForHiddenParticipant } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The hospital\'s system starts an encounter for an HN through the coordinator service. The service \
asks the recorder bot to record the patient\'s room, so the bot is in the room when the patient joins, and the \
encounter is waiting. Starting it again returns the same encounter. The encounter survives a restart of the service, \
only the right bearer secret is accepted, and no HN reaches the service\'s logs. Skipped unless the deployment is the \
JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1' ]
});

describe('Coordinator: start an encounter', () => {
    const since = new Date();
    let hn: string;
    let encounterId: string;
    let patient: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('ENC');
    });

    it('refuses a request without the right bearer secret', async () => {
        expect((await callCoordinator('/encounters', { body: JSON.stringify({ hn }), method: 'POST' }, '')).status)
            .toBe(401);
        expect((await callCoordinator('/encounters', { body: JSON.stringify({ hn }), method: 'POST' }, 'wrong'))
            .status).toBe(401);
    });

    it('starts an encounter in the waiting stage, with an id that does not contain the HN', async () => {
        const { body, status } = await postEncounter(hn);

        expect(status).toBe(201);
        expect(body.stage).toBe('waiting');
        expect(body.id).not.toContain(hn);
        encounterId = body.id;
    });

    it('has the recorder bot in the patient\'s room when the patient joins', async () => {
        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: 'Patient P',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });

        await waitForHiddenParticipant(patient);
    });

    it('returns the same encounter when it is started again', async () => {
        const again = await postEncounter(hn);

        expect(again.status).toBe(200);
        expect(again.body.id).toBe(encounterId);
    });

    it('gives another HN an encounter of its own', async () => {
        const other = await postEncounter(uniqueHn('OTHER'));

        expect(other.status).toBe(201);
        expect(other.body.id).not.toBe(encounterId);
    });

    it('keeps the encounter across a restart of the service', async () => {
        await restartCoordinator();

        const { body, status } = await getEncounter(encounterId);

        expect(status).toBe(200);
        expect(body.stage).toBe('waiting');
        expect((await postEncounter(hn)).body.id).toBe(encounterId);
    });

    it('refuses a bad HN', async () => {
        expect((await callCoordinator('/encounters', { body: JSON.stringify({ hn: '' }), method: 'POST' })).status)
            .toBe(400);
    });

    it('writes no HN to its logs', () => {
        expect(coordinatorLogs(since)).not.toContain(hn);
    });
});
