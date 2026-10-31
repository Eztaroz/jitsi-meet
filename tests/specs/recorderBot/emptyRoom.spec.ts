import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    getConsultation,
    patientLinkRoom,
    recorderBotUnavailableReason,
    startConsultation,
    uniqueHn,
    waitForConsultation,
    waitForHiddenParticipant,
    waitForStop
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The recorder bot waits for the first participant, stays while a participant rejoins within the \
empty-room grace, and stops once the room has been empty for the grace. Skipped unless the recorderBot.available \
expectation is set; meant for a deployment with a short grace.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: empty room', () => {
    const graceMs = expectations.recorderBot.emptyRoomGraceSeconds * 1000;
    let p1: Participant;
    let consultationId: string;
    let room: string;

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn();

        room = patientLinkRoom(hn);
        consultationId = (await startConsultation(hn)).consultationId;
    });

    it('the consultation waits for participants until the first one joins', async () => {
        await waitForConsultation(consultationId, c => c.status === 'waiting_for_participants', {
            description: 'the bot to wait for participants'
        });

        p1 = await joinMuc({ name: 'p1' }, { roomName: room });
        await waitForHiddenParticipant(p1);
        await waitForConsultation(consultationId, c => c.status === 'recording', {
            description: 'the consultation to record'
        });
    });

    it('a participant who rejoins within the grace keeps the bot', async () => {
        await p1.hangup();
        await p1.driver.pause(graceMs / 2);
        p1 = await joinMuc({ name: 'p1' }, { roomName: room });
        await waitForHiddenParticipant(p1);

        // Past the grace counted from the leave.
        await p1.driver.pause(graceMs);

        const consultation = await getConsultation(consultationId);

        expect(consultation.status).toBe('recording');
        expect(consultation.stopReason).toBeUndefined();
    });

    it('the bot stops once the room has been empty for the grace', async () => {
        await p1.hangup();

        const leftAt = Date.now();
        const consultation = await waitForStop(consultationId, graceMs + 30_000);
        const stoppedAfterMs = Date.parse(consultation.stoppedAt ?? '') - leftAt;

        expect(consultation.stopReason).toBe('no_humans_for_grace');

        // Not before the grace, with a second for the participant's leave to reach the bot.
        expect(stoppedAfterMs).toBeGreaterThanOrEqual(graceMs - 1000);
        expect(stoppedAfterMs).toBeLessThan(graceMs + 15_000);
    });
});
