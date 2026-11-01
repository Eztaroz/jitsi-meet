import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IManifest,
    getConsultation,
    identityUnavailableReason,
    postConsultation,
    postStationConsultation,
    readEvidenceJson,
    uniqueHn,
    waitForConsultation,
    waitForEvidence,
    waitForRecording,
    waitForStop
} from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The recorder bot records one patient\'s time in a station as a consultation of its own: it stops \
when that patient leaves though the nurse stays, and keeps the evidence recording under the patient\'s HN, with the \
station named in the manifest and only that patient\'s time in it. Repeating the request returns the same \
consultation, and a patient\'s own room for the same HN is recorded at the same time. Skipped unless the deployment \
is the JWT variant of the test deployment and RECORDER_BOT_STORAGE_ROOT is set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Recorder bot: a patient in a station', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const nurseIdentity = { id: `nurse-${uuidv4()}`, name: 'Nurse N' };
    let hn: string;
    let station: string;
    let consultationId: string;
    let patient: Participant;
    let nurse: Participant;

    it('setup', async () => {
        const unavailable = identityUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('STATION');
        station = `station-${uuidv4()}`;

        const { body, status } = await postStationConsultation(hn, station, patientIdentity.id);

        expect(status).toBe(201);
        consultationId = body.consultationId;
        expect((await getConsultation(consultationId)).conferenceRoom).toBe(station.toLowerCase());
    });

    it('returns the same consultation for a repeated request for the same HN and station', async () => {
        const again = await postStationConsultation(hn, station, patientIdentity.id);

        expect(again.status).toBe(200);
        expect(again.body.consultationId).toBe(consultationId);
    });

    it('records the nurse and the patient in the station', async () => {
        nurse = await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: nurseIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: nurseIdentity.id }
            })
        }, { roomName: station });
        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: station });
        await waitForRecording(consultationId);
        await patient.driver.pause(5_000);
    });

    it('records the patient\'s own room for the same HN at the same time', async () => {
        const own = await postConsultation(hn);

        expect(own.status).toBe(201);
        expect(own.body.consultationId).not.toBe(consultationId);

        // Nobody joins the patient's own room: it ends by itself, so it does not outlive the test.
        await waitForStop(own.body.consultationId, 60_000);
    });

    it('stops as soon as the patient leaves, though the nurse stays', async () => {
        await patient.hangup();

        const stopped = await waitForStop(consultationId, 15_000);

        expect(stopped.stopReason).toBe('patient_left');
        expect(await nurse.isInMuc()).toBe(true);
    });

    it('keeps the evidence recording under the patient\'s HN, with the station and the patient\'s time', async () => {
        const location = (await waitForEvidence(consultationId)).evidenceLocation ?? '';
        const manifest = readEvidenceJson<IManifest>(location, 'manifest.json');

        expect(manifest.hn).toBe(hn);
        expect(manifest.station).toBe(station.toLowerCase());
        expect(manifest.stopReason).toBe('patient_left');
        expect(manifest.identities.map(i => i.identity.id)).toEqual(
            expect.arrayContaining([ patientIdentity.id, nurseIdentity.id ]));

        const done = await waitForConsultation(consultationId, c => c.status === 'stored', {
            description: 'the evidence recording to be stored'
        });

        expect(done.status).toBe('stored');
    });
});
