import { setTestProperties } from '../../helpers/TestProperties';
import { expectations } from '../../helpers/expectations';
import {
    recorderBotUnavailableReason,
    startConsultation,
    uniqueHn,
    waitForConsultation,
    waitForStop
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The recorder bot stops when nobody joins within the first-join wait. Skipped unless the \
recorderBot.available expectation is set; meant for a deployment with a short wait.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: nobody joins', () => {
    const waitMs = expectations.recorderBot.firstJoinWaitSeconds * 1000;
    let consultationId: string;

    it('setup', () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    it('a room nobody joins ends with no_one_joined', async () => {
        consultationId = (await startConsultation(uniqueHn())).consultationId;

        const waiting = await waitForConsultation(consultationId, c => c.status === 'waiting_for_participants', {
            description: 'the bot to wait for participants'
        });
        const consultation = await waitForStop(consultationId, waitMs + 30_000);
        const stoppedAfterMs = Date.parse(consultation.stoppedAt ?? '') - Date.parse(waiting.startedAt);

        expect(consultation.stopReason).toBe('no_one_joined');

        // The wait is counted from the bot's join, a little after the request.
        expect(stoppedAfterMs).toBeGreaterThanOrEqual(waitMs);
        expect(stoppedAfterMs).toBeLessThan(waitMs + 15_000);
    });
});
