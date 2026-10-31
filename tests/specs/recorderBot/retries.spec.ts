import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { joinMuc } from '../../helpers/joinMuc';
import {
    getHiddenView,
    patientLinkRoom,
    postConsultation,
    recorderBotUnavailableReason,
    uniqueHn,
    waitForHiddenParticipant,
    waitForRecording,
    waitForStop
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The hospital\'s room-creation system can safely retry a request to record a patient\'s room: while \
the consultation runs, every request for that HN returns it, and only one bot joins. Once it has ended, a request \
starts a new consultation. Skipped unless the recorderBot.available expectation is set.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: safe retries', () => {
    let p1: Participant;
    let hn: string;
    let consultationId: string;

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('RETRY');

        const { body, status } = await postConsultation(hn);

        expect(status).toBe(201);
        consultationId = body.consultationId;
    });

    it('a repeated request for the same HN returns the same consultation', async () => {
        const again = await postConsultation(hn);

        expect(again.status).toBe(200);
        expect(again.body.consultationId).toBe(consultationId);

        // The same HN written differently names the same room, so the same consultation.
        expect((await postConsultation(hn.toLowerCase())).body.consultationId).toBe(consultationId);
    });

    it('only one bot joins the room', async () => {
        p1 = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(hn) });
        await waitForRecording(consultationId);
        await waitForHiddenParticipant(p1);

        // A second bot would have joined well within this.
        await p1.driver.pause(5_000);
        expect((await getHiddenView(p1)).hidden.length).toBe(1);
    });

    it('once the consultation has ended, a request for the same HN starts a new one', async () => {
        await p1.getToolbar().clickEndMeetingForAllButton();
        await waitForStop(consultationId);

        const next = await postConsultation(hn);

        expect(next.status).toBe(201);
        expect(next.body.consultationId).not.toBe(consultationId);

        // Nobody joins this one; it ends on its own after the first-join wait.
    });
});
