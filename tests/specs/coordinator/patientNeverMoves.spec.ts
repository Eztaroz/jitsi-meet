import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getAudit,
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
    description: 'Staff come to the patient (ADR 0011): a patient stays in their own room for the whole encounter, \
and a move of a patient is refused with its reason, in the answer and in the audit log, whether to a lounge or to \
another room; the patient stays where they are. A station is a team with a lounge of its own: the rooms report names \
the station of a staff member in its lounge, and keeps naming it while they are in a patient\'s room. Skipped unless \
the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

const LOUNGE = 'lounge-intake';

describe('Coordinator: a patient is never moved', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const nurseIdentity = { id: `nurse-${uuidv4()}`, name: 'Nurse N' };
    let hn: string;
    let patient: Participant;
    let patientEndpoint: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('STAY');
        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: nurseIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: nurseIdentity.id }
            })
        }, { roomName: LOUNGE });

        const room = await waitForRoom(r => r?.occupants.some(o => o.identity?.id === patientIdentity.id) === true,
            hn, 'the patient in their room');

        patientEndpoint = room!.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;
    });

    it('refuses to move the patient into a lounge or another room, and says why', async () => {
        for (const to of [ LOUNGE, `other-${uuidv4()}` ]) {
            const { body, status } = await postMove(hn.toLowerCase(), patientEndpoint, to);

            expect(status).toBe(200);
            expect(body.state).toBe('refused');
            expect(body.reason).toBe('patients_never_move');
        }
    });

    it('leaves the patient in their own room, and never shows them a move', async () => {
        expect(await (await patient.driver.$('#coordinator-move-notice')).isExisting()).toBe(false);

        const room = await waitForRoom(r => r !== undefined, hn, 'the patient\'s room');

        expect(room!.occupants.some(o => o.identity?.id === patientIdentity.id)).toBe(true);
        expect(await patient.isInMuc()).toBe(true);
    });

    it('audits each refusal with its reason, without the HN', async () => {
        const mine = (await getAudit(1000)).filter(e => e.kind === 'move' && e.participantId === patientIdentity.id);

        expect(mine.length).toBe(2);
        expect(mine.every(e => e.outcome === 'refused' && e.reason === 'patients_never_move')).toBe(true);
        expect(JSON.stringify(mine).toLowerCase()).not.toContain(hn.toLowerCase());
    });

    it('names the station of the staff member in its lounge', async () => {
        const lounge = (await getRooms()).find(r => r.name === LOUNGE)!;

        expect(lounge).toMatchObject({ kind: 'lounge', open: true, stage: 'intake', station: 'intake' });
        expect(lounge.occupants.find(o => o.identity?.id === nurseIdentity.id)?.station).toBe('intake');
    });

    it('keeps naming it while the staff member is in the patient\'s room', async () => {
        const lounge = (await getRooms()).find(r => r.name === LOUNGE)!;
        const nurseEndpoint = lounge.occupants.find(o => o.identity?.id === nurseIdentity.id)!.endpointId;
        const { body } = await postMove(LOUNGE, nurseEndpoint, hn.toLowerCase());

        expect(body.state).toBe('counting_down');
        await waitForMove(body.id, 'done');

        const room = await waitForRoom(r => r?.occupants.some(o => o.identity?.id === nurseIdentity.id) === true,
            hn, 'the nurse in the patient\'s room');

        expect(room!.occupants.find(o => o.identity?.id === nurseIdentity.id)?.station).toBe('intake');
        expect(room!.occupants.find(o => o.identity?.id === patientIdentity.id)?.station).toBeUndefined();
    });
});
