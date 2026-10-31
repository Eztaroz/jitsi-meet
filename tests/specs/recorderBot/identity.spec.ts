import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IIdentity,
    type IManifest,
    type ITimelineEntry,
    identityUnavailableReason,
    patientLinkRoom,
    readEvidenceJson,
    startConsultation,
    uniqueHn,
    waitForConsultation,
    waitForEvidence,
    waitForRecording
} from '../../helpers/recorderBot';
import { type IToken, generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'In a deployment that verifies participants\' identities with JWT, the recorder bot waits for an \
authenticated participant to start the room, then records who each participant is. Staff who leave and join again \
make two staff visits under the same identity, at their joins and leaves; the patient\'s files are attributed to the \
patient. Skipped unless the recorderBot.verifiedIdentities expectation, JWT_KID, JWT_PRIVATE_KEY_PATH and \
RECORDER_BOT_STORAGE_ROOT are set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

/**
 * Returns a token for a participant with a fixed identity.
 *
 * @param {IIdentity} identity - The identity.
 * @param {Record<string, string>} roleClaims - The claims that give the participant its role.
 * @returns {IToken}
 */
function tokenFor(identity: IIdentity, roleClaims: Record<string, string>): IToken {
    return generateToken({ displayName: identity.name, userClaims: { ...roleClaims, id: identity.id } });
}

describe('Recorder bot: staff visits from verified identity', () => {
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    let patient: Participant;
    let consultationId: string;
    let manifest: IManifest;
    let timeline: ITimelineEntry[];

    /** The endpoint of each participant join, in order: the patient, then staff twice. */
    const endpoints: string[] = [];

    it('setup', async () => {
        const unavailable = identityUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn('ID');
        const room = patientLinkRoom(hn);
        const staffToken = tokenFor(staffIdentity, expectations.recorderBot.staffClaims);

        // Nobody is in the room yet, and the bot may not start it.
        consultationId = (await startConsultation(hn)).consultationId;
        await waitForConsultation(consultationId, c => c.status === 'waiting_for_participants', {
            description: 'the bot to wait for a host'
        });

        patient = await joinMuc(
            { name: 'p1', token: tokenFor(patientIdentity, expectations.recorderBot.patientClaims) },
            { roomName: room });
        endpoints.push(await patient.getEndpointId());
        await waitForRecording(consultationId);

        let staff = await joinMuc({ name: 'p2', token: staffToken }, { roomName: room });

        endpoints.push(await staff.getEndpointId());
        await staff.driver.pause(5_000);

        // The same identity joins again, as a new endpoint.
        await staff.hangup();
        await patient.driver.pause(3_000);
        staff = await joinMuc({ name: 'p2', token: staffToken }, { roomName: room });
        endpoints.push(await staff.getEndpointId());
        await staff.driver.pause(5_000);

        await patient.getToolbar().clickEndMeetingForAllButton();

        const location = (await waitForEvidence(consultationId)).evidenceLocation ?? '';

        manifest = readEvidenceJson<IManifest>(location, 'manifest.json');
        timeline = readEvidenceJson<{ entries: ITimelineEntry[]; }>(location, 'timeline.json').entries;
    });

    it('the bot waited for an authenticated participant to start the room', () => {
        const types = timeline.map(e => e.type);

        expect(types[0]).toBe('waiting_for_host');
        expect(types).toContain('bot_joined');
    });

    it('every participant is recorded with their verified identity and role', () => {
        expect(manifest.participants.map(p => [ p.endpointId, p.identity, p.role ])).toEqual([
            [ endpoints[0], patientIdentity, 'patient' ],
            [ endpoints[1], staffIdentity, 'staff' ],
            [ endpoints[2], staffIdentity, 'staff' ]
        ]);
    });

    it('staff who leave and join again make two staff visits, at their joins and leaves', () => {
        const [ , first, second ] = manifest.participants;

        expect(manifest.staffVisits.map(({ end, endpointId, identity, start }) => {
            return { end, endpointId, identity, start };
        })).toEqual([
            { end: first.leaves[0], endpointId: first.endpointId, identity: staffIdentity, start: first.joins[0] },

            // Still in the room at the end.
            { end: manifest.end, endpointId: second.endpointId, identity: staffIdentity, start: second.joins[0] }
        ]);
    });

    it('each identity\'s files are attributed to it, across its joins', () => {
        const filesOf = (endpointIds: string[]) =>
            manifest.files.filter(f => endpointIds.includes(f.endpointId)).map(f => f.name);

        expect(filesOf([ endpoints[0] ]).length).toBe(2);
        expect(filesOf(endpoints.slice(1)).length).toBe(4);
        expect(manifest.identities).toEqual([
            {
                endpointIds: [ endpoints[0] ],
                files: filesOf([ endpoints[0] ]),
                identity: patientIdentity,
                role: 'patient'
            },
            {
                endpointIds: endpoints.slice(1),
                files: filesOf(endpoints.slice(1)),
                identity: staffIdentity,
                role: 'staff'
            }
        ]);
    });
});
