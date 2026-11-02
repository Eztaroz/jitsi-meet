import { v4 as uuidv4 } from 'uuid';

import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    findEvidence,
    identityUnavailableReason,
    postStationConsultation,
    spoolHasFolder,
    stopConsultation,
    uniqueHn,
    waitForConsultation,
    waitForRecording,
    waitForStop
} from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A station consultation whose patient never arrives is stopped and discarded: no evidence recording \
is kept and its folder leaves the spool. So is one the hospital\'s system stops early before the patient arrived, \
while one stopped early after the patient arrived is kept. Skipped unless the deployment is the JWT variant of the \
test deployment and RECORDER_BOT_STORAGE_ROOT is set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Recorder bot: a station consultation that is discarded', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const nurseIdentity = { id: `nurse-${uuidv4()}`, name: 'Nurse N' };

    it('setup', async () => {
        const unavailable = identityUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    it('discards it when the patient does not arrive in time, though the nurse is there', async () => {
        const station = `station-${uuidv4()}`;
        const { body } = await postStationConsultation(uniqueHn('NOSHOW'), station, patientIdentity.id);

        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: nurseIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: nurseIdentity.id }
            })
        }, { roomName: station });
        await waitForRecording(body.consultationId);

        const stopped = await waitForStop(
            body.consultationId, (expectations.recorderBot.patientWaitSeconds + 30) * 1000);

        expect(stopped.stopReason).toBe('patient_did_not_arrive');

        const done = await waitForConsultation(body.consultationId, c => c.status === 'discarded', {
            description: 'the consultation to be discarded'
        });

        expect(done.status).toBe('discarded');
        expect(findEvidence(config.recorderBot.storageRoot ?? '', body.consultationId)).toBeUndefined();
        expect(spoolHasFolder(body.consultationId)).toBe(false);
    });

    it('discards it when it is stopped early before the patient arrived', async () => {
        const { body } = await postStationConsultation(uniqueHn('EARLY'), `station-${uuidv4()}`, patientIdentity.id);

        await waitForConsultation(body.consultationId, c => c.status !== 'starting', { description: 'it to start' });

        const stopped = await stopConsultation(body.consultationId);

        expect(stopped.stopReason).toBe('stop_requested');
        expect(stopped.status).toBe('discarded');
        expect(findEvidence(config.recorderBot.storageRoot ?? '', body.consultationId)).toBeUndefined();
        expect(spoolHasFolder(body.consultationId)).toBe(false);
    });

    it('keeps it when it is stopped early after the patient arrived', async () => {
        const hn = uniqueHn('KEPT');
        const station = `station-${uuidv4()}`;
        const { body } = await postStationConsultation(hn, station, patientIdentity.id);
        const patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: station });

        await waitForRecording(body.consultationId);
        await patient.driver.pause(3_000);

        const stopped = await stopConsultation(body.consultationId);

        expect(stopped.stopReason).toBe('stop_requested');
        expect([ 'stored', 'spooled' ]).toContain(stopped.status);
        expect(findEvidence(config.recorderBot.storageRoot ?? '', body.consultationId)).toBeDefined();
    });
});
