import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    callCoordinator,
    coordinatorLogs,
    coordinatorUnavailableReason,
    getAudit,
    getEncounter,
    postEncounter,
    postMove,
    postStage,
    seedOldData,
    waitForMove,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'Every move and every stage change is written to the audit log with when, who asked (the system), \
who was moved, from where to where, and what came of it: done, cancelled, refused. A patient\'s room is a keyed \
reference and never the HN, a station is named. Encounters and audit entries older than the retention period are \
deleted by the sweep, and recent ones are left. No HN reaches the service\'s logs or the audit log. Skipped unless the \
deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: audit log and retention', () => {
    const since = new Date();
    const staffIdentity = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patientIdentity = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let lounge: string;
    let staff: Participant;
    let staffEndpoint: string;
    let encounterId: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('AUDIT');
        lounge = `lounge-${uuidv4()}`;
        encounterId = (await postEncounter(hn)).body.id;
        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: patientIdentity.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patientIdentity.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        staff = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: staffIdentity.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: staffIdentity.id }
            })
        }, { roomName: lounge });
        staffEndpoint = await staff.getEndpointId();
        await waitForRoom(r => r !== undefined, hn, 'the patient\'s room');
    });

    it('writes an entry for a refused move, a cancelled move, a done move and a stage change', async () => {
        await postMove(lounge, 'nobody', hn.toLowerCase());

        const cancelled = (await postMove(lounge, staffEndpoint, hn.toLowerCase())).body;

        await (await staff.driver.$('#coordinator-move-cancel')).waitForExist({ timeout: 10_000 });
        await (await staff.driver.$('#coordinator-move-cancel')).click();
        await waitForMove(cancelled.id, 'cancelled', 15_000);

        await staff.driver.pause(1_000);

        const room = await waitForRoom(r => r !== undefined, hn, 'the room');

        expect(room).toBeDefined();
        expect((await postStage(encounterId, 'intake')).status).toBe(200);
        expect((await postStage(encounterId, 'lunch')).status).toBe(400);

        const entries = await getAudit(1000);
        const moves = entries.filter(e => e.kind === 'move' && e.participantId === staffIdentity.id);
        const stage = entries.find(e => e.kind === 'stage' && e.encounterId === encounterId);

        expect(moves.map(m => m.outcome)).toContain('cancelled');
        expect(stage).toMatchObject({ from: 'waiting', issuer: 'system', outcome: 'ok', to: 'intake' });
        expect(entries.some(e => e.kind === 'move' && e.outcome === 'refused' && e.reason === 'participant_not_found')).toBe(true);
    });

    it('names a patient\'s room by a keyed reference, never by the HN', async () => {
        const entries = await getAudit(1000);
        const cancelled = entries.find(e => e.kind === 'move' && e.participantId === staffIdentity.id)!;

        expect(cancelled.issuer).toBe('system');
        expect(cancelled.destination).toMatch(/^room:[0-9a-f]{16}$/u);
        expect(JSON.stringify(entries).toLowerCase()).not.toContain(hn.toLowerCase());
        expect(JSON.stringify(entries).toLowerCase()).not.toContain(encodeURIComponent(hn.toLowerCase()));
    });

    it('writes no HN to the service\'s logs', () => {
        expect(coordinatorLogs(since).toLowerCase()).not.toContain(hn.toLowerCase());
    });

    it('requires the bearer secret to read the audit log', async () => {
        expect((await callCoordinator('/audit', {}, '')).status).toBe(401);
    });

    it('deletes what is older than the retention period, and leaves what is not', async () => {
        const old = { encounterId: uuidv4(), oldParticipant: `old-${uuidv4()}`, recentParticipant: `recent-${uuidv4()}` };

        await seedOldData(old);
        await staff.driver.pause(5_000);

        expect((await getEncounter(old.encounterId)).status).toBe(404);

        const entries = await getAudit(1000);

        expect(entries.some(e => e.participantId === old.oldParticipant)).toBe(false);
        expect(entries.some(e => e.participantId === old.recentParticipant)).toBe(true);
        expect((await getEncounter(encounterId)).status).toBe(200);
    });
});
