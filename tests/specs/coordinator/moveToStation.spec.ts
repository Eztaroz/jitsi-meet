import fs from 'node:fs';
import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    callCoordinator,
    coordinatorUnavailableReason,
    postEncounter,
    postMove,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IManifest,
    evidencePath,
    patientLinkRoom,
    readEvidenceJson,
    uniqueHn
} from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'Moving a patient into a station records them there: the recorder bot is in the station for the \
patient before they arrive, the evidence recording is kept under the patient\'s HN with the station named, and it \
stops when the patient is moved back. A move the patient cancels leaves no station evidence recording behind. A doctor \
staying in the patient\'s own room while the patient is in a station is still recorded there. Skipped unless the \
deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3' ]
});

/**
 * Lists the manifests of the evidence recordings kept for an HN that took place in a station.
 *
 * @param {string} hn - The patient's HN.
 * @returns {IManifest[]}
 */
function stationEvidence(hn: string): IManifest[] {
    const folder = evidencePath(encodeURIComponent(hn.toLowerCase()).toLowerCase());

    if (!fs.existsSync(folder)) {
        return [];
    }

    return fs.readdirSync(folder)
        .flatMap(start => {
            try {
                return [ readEvidenceJson<IManifest>(`${encodeURIComponent(hn.toLowerCase()).toLowerCase()}/${start}`, 'manifest.json') ];
            } catch {
                return [];
            }
        })
        .filter(m => m.station);
}

describe('Coordinator: move a patient into a station', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const nurseIdentity = { id: `nurse-${uuidv4()}`, name: 'Nurse N' };
    const doctorIdentity = { id: `doctor-${uuidv4()}`, name: 'Doctor D' };
    let hn: string;
    let patient: Participant;
    let nurse: Participant;
    let doctor: Participant;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable || !config.recorderBot.storageRoot) {
            ctx.skipSuiteTests = unavailable ?? 'RECORDER_BOT_STORAGE_ROOT is not set';

            return;
        }

        hn = uniqueHn('STN');
        expect((await postEncounter(hn)).status).toBe(201);

        const staffToken = (identity: { id: string; name: string; }) => generateToken({
            displayName: identity.name,
            userClaims: { ...expectations.recorderBot.staffClaims, id: identity.id }
        });

        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: patientIdentity.name,
                room: encodeURIComponent(hn.toLowerCase()).toLowerCase(),
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        doctor = await joinMuc({ name: 'p3', token: staffToken(doctorIdentity) }, { roomName: patientLinkRoom(hn) });
        nurse = await joinMuc({ name: 'p2', token: staffToken(nurseIdentity) }, { roomName: 'intake-1' });
        await waitForRoom(r => r?.occupants.length === 3, hn, 'the patient, the doctor and the bot');
    });

    let cancelledMove: string;

    it('a move the patient cancels leaves no station evidence recording behind', async () => {
        const room = await waitForRoom(r => r !== undefined, hn, 'the room');
        const endpoint = room!.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;
        const { body } = await postMove(hn.toLowerCase(), endpoint, 'intake-1');

        expect(body.state).toBe('preparing');
        cancelledMove = body.id;

        await (await patient.driver.$('#coordinator-move-cancel')).waitForExist({ timeout: 30_000 });
        await (await patient.driver.$('#coordinator-move-cancel')).click();
        await waitForMove(cancelledMove, 'cancelled', 20_000);
        await patient.driver.pause(8_000);

        expect(stationEvidence(hn)).toEqual([]);
    });

    it('moves the patient into the station, where the recorder bot is waiting for them', async () => {
        const room = await waitForRoom(r => r !== undefined, hn, 'the room');
        const endpoint = room!.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;
        const { body } = await postMove(hn.toLowerCase(), endpoint, 'intake-1');

        expect(body.state).toBe('preparing');
        await waitForMove(body.id, 'done');
    });

    it('records the patient in the station, and the doctor in their own room', async () => {
        const rooms = await (await callCoordinator('/rooms')).json() as { rooms: { name: string; occupants: { identity?: { id?: string; }; role: string; }[]; }[]; };
        const station = rooms.rooms.find(r => r.name === 'intake-1')!;
        const own = rooms.rooms.find(r => r.name === hn.toLowerCase())!;

        expect(station.occupants.some(o => o.identity?.id === patientIdentity.id)).toBe(true);
        expect(station.occupants.some(o => o.role === 'hidden')).toBe(true);
        expect(own.occupants.some(o => o.identity?.id === doctorIdentity.id)).toBe(true);
        expect(own.occupants.some(o => o.role === 'hidden')).toBe(true);
        expect(await nurse.isInMuc()).toBe(true);
        expect(await doctor.isInMuc()).toBe(true);
    });

    it('stops, and keeps the evidence under the HN with the station named, when the patient is moved back', async () => {
        const station = (await (await callCoordinator('/rooms')).json() as { rooms: { name: string; occupants: { endpointId: string; identity?: { id?: string; }; }[]; }[]; })
            .rooms.find(r => r.name === 'intake-1')!;
        const endpoint = station.occupants.find(o => o.identity?.id === patientIdentity.id)!.endpointId;
        const { body } = await postMove('intake-1', endpoint, hn.toLowerCase());

        await waitForMove(body.id, 'done');

        // The station's consultation stops as the patient leaves, and is stored under their HN.
        await patient.driver.waitUntil(() => stationEvidence(hn).length > 0, {
            timeout: 60_000,
            timeoutMsg: 'no station evidence recording was stored'
        });

        const [ manifest ] = stationEvidence(hn);

        expect(manifest.hn).toBe(hn);
        expect(manifest.station).toBe('intake-1');
        expect(manifest.stopReason).toBe('patient_left');
        expect(manifest.identities.map(i => i.identity.id)).toContain(patientIdentity.id);
    });
});
