import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    type IMove,
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
    description: 'The coordinator moves patients, and keeps them safe: a patient may go to a station that holds only \
staff, never into a room that holds another patient nor into a lounge. A patient\'s own token opens their own room \
only, and the token a move brings opens its destination only. A patient is moved back to their own room while it is \
closed: the recorder bot is waiting for the room before they arrive. With the recorder bot at capacity the move fails and the \
patient stays where they are. Skipped unless the deployment is the JWT variant of the recorder bot\'s test \
deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3' ]
});

/**
 * Names a room as Prosody does, for a token's room claim.
 *
 * @param {string} name - The room as people know it.
 * @returns {string}
 */
function safeName(name: string): string {
    return encodeURIComponent(name.toLowerCase()).toLowerCase();
}

describe('Coordinator: move patients', () => {
    const nurseIdentity = { id: `nurse-${uuidv4()}`, name: 'Nurse N' };
    const patientA = { id: `patient-${uuidv4()}`, name: 'Patient A' };
    const patientB = { id: `patient-${uuidv4()}`, name: 'Patient B' };
    let hnA: string;
    let hnB: string;
    let a: Participant;
    let b: Participant;
    let nurse: Participant;

    /**
     * Returns a patient's own token: it opens their own room only.
     *
     * @param {Object} identity - Who.
     * @param {string} hn - Their HN.
     * @returns {Object}
     */
    function patientToken(identity: { id: string; name: string; }, hn: string) {
        return generateToken({
            displayName: identity.name,
            room: safeName(hn),
            userClaims: { ...expectations.recorderBot.patientClaims, id: identity.id }
        });
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hnA = uniqueHn('PATA');
        hnB = uniqueHn('PATB');
        a = await joinMuc({ name: 'p1', token: patientToken(patientA, hnA) }, { roomName: patientLinkRoom(hnA) });
        b = await joinMuc({ name: 'p2', token: patientToken(patientB, hnB) }, { roomName: patientLinkRoom(hnB) });
        nurse = await joinMuc({
            name: 'p3',
            token: generateToken({
                displayName: nurseIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: nurseIdentity.id }
            })
        }, { roomName: 'intake-1' });
        await waitForRoom(r => r?.occupants.length === 1, hnA, 'patient A in their room');
    });

    it('labels the configured stations and lounges, the closed ones too', async () => {
        const rooms = await getRooms();
        const byName = Object.fromEntries(rooms.map(r => [ r.name, r ]));

        expect(byName['intake-1']).toMatchObject({ kind: 'station', open: true, stage: 'intake' });
        expect(byName['aftercare-1']).toMatchObject({ kind: 'station', open: false, stage: 'aftercare' });
        expect(byName['lounge-1']).toMatchObject({ kind: 'lounge', open: false });
        expect(byName[hnA.toLowerCase()]).toMatchObject({ kind: 'patient', open: true });
    });

    it('does not let a patient\'s own token open another patient\'s room', async () => {
        let inRoom = false;

        try {
            const intruder = await joinMuc({ name: 'p1', token: patientToken(patientA, hnA) }, { roomName: patientLinkRoom(hnB) });

            inRoom = Boolean(await intruder.isInMuc());
        } catch {
            inRoom = false;
        }
        expect(inRoom).toBe(false);

        // Back where they belong, for the rest.
        a = await joinMuc({ name: 'p1', token: patientToken(patientA, hnA) }, { roomName: patientLinkRoom(hnA) });
        await waitForRoom(r => r?.occupants.some(o => o.identity?.id === patientA.id) === true, hnA, 'patient A back');
    });

    let toStation: IMove;

    it('moves a patient to a station that holds only staff', async () => {
        const room = await waitForRoom(r => r !== undefined && r.occupants.length === 1, hnA, 'patient A alone');
        const endpoint = room!.occupants[0].endpointId;
        const { body, status } = await postMove(hnA.toLowerCase(), endpoint, 'intake-1');

        expect(status).toBe(202);
        toStation = await waitForMove(body.id, 'done');
        expect(toStation.state).toBe('done');
    });

    it('refuses a patient a room that holds another patient, and a lounge', async () => {
        const roomB = await waitForRoom(r => r?.occupants.length === 1, hnB, 'patient B');
        const endpoint = roomB!.occupants[0].endpointId;
        const intoStation = await postMove(hnB.toLowerCase(), endpoint, 'intake-1');

        expect(intoStation.body.state).toBe('refused');
        expect(intoStation.body.reason).toBe('destination_holds_a_patient');

        const intoLounge = await postMove(hnB.toLowerCase(), endpoint, 'lounge-1');

        expect(intoLounge.body.state).toBe('refused');
        expect(intoLounge.body.reason).toBe('patient_into_lounge');
    });

    it('brings a token that opens its destination only', async () => {
        let jwt = '';

        // The move's page replaced the participant's; the token is in its store.
        await a.driver.waitUntil(() => a.isInMuc());
        jwt = await a.execute(() => APP.store.getState()['features/base/jwt'].jwt as string);

        let inRoom = false;

        try {
            const intruder = await joinMuc({ name: 'p2', token: { jwt } }, { roomName: patientLinkRoom(hnB) });

            inRoom = Boolean(await intruder.isInMuc());
        } catch {
            inRoom = false;
        }
        expect(inRoom).toBe(false);

        // Patient B left their room to try; put them back.
        b = await joinMuc({ name: 'p2', token: patientToken(patientB, hnB) }, { roomName: patientLinkRoom(hnB) });
        await waitForRoom(r => r?.occupants.some(o => o.identity?.id === patientB.id) === true, hnB, 'patient B back');
    });

    it('moves a patient back to their own room while it is closed: the recorder bot is waiting for it', async () => {
        // Patient A's own room closed when they left it.
        const room = await waitForRoom(r => r === undefined || !r.open || r.occupants.length === 0, hnA, 'their room closed')
            .catch(() => undefined);

        expect(room?.occupants.length ?? 0).toBe(0);

        const station = (await getRooms()).find(r => r.name === 'intake-1')!;
        const endpoint = station.occupants.find(o => o.identity?.id === patientA.id)!.endpointId;
        const { body } = await postMove('intake-1', endpoint, hnA.toLowerCase());

        expect(body.state).toBe('preparing');
        await waitForMove(body.id, 'done');

        await waitForRoom(r => r?.occupants.some(o => o.identity?.id === patientA.id) === true, hnA, 'A at home');

        // With token authentication the bot cannot start a room, so it joins as soon as the patient has: it was
        // already waiting, which is why the move was sent.
        await waitForRoom(r => r?.occupants.some(o => o.role === 'hidden') === true, hnA, 'the recorder bot in the room');
    });

    it('fails the move, and leaves the patient where they are, when the recorder bot is at capacity', async () => {
        // Fill the recorder bot's consultations; they end by themselves, nobody being in their rooms.
        for (let i = 0; i < 6; i++) {
            if ((await postConsultation(uniqueHn(`FILL${i}`))).status === 503) {
                break;
            }
        }

        const roomB = await waitForRoom(r => r?.occupants.some(o => o.identity?.id === patientB.id) === true, hnB, 'B');
        const endpoint = roomB!.occupants.find(o => o.identity?.id === patientB.id)!.endpointId;
        const { body } = await postMove(hnB.toLowerCase(), endpoint, uniqueHn('CLOSED').toLowerCase());

        expect(body.state).toBe('preparing');
        await waitForMove(body.id, 'failed', 30_000);

        const failed = await (await fetch(`${process.env.COORDINATOR_API_URL}/moves/${body.id}`, {
            headers: { 'Authorization': `Bearer ${process.env.COORDINATOR_API_SECRET}` }
        })).json() as IMove;

        expect(failed.reason).toBe('recorder_bot_at_capacity');
        expect(await b.isInMuc()).toBe(true);
        expect(await b.driver.getUrl()).toContain(encodeURIComponent(hnB));
        expect(nurse).toBeDefined();

        // The consultations that filled the recorder bot end by themselves; let them, for the specs that follow.
        await b.driver.pause(25_000);
    });
});
