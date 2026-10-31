import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { joinMuc } from '../../helpers/joinMuc';
import {
    getHealth,
    getHiddenView,
    patientLinkRoom,
    postConsultation,
    recorderBotUnavailableReason,
    uniqueHn
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'A recorder bot service at its limit of concurrent consultations refuses another HN with 503 and \
starts nothing, and still answers a repeated request for a consultation it runs. Runs against a second instance of \
the service whose limit is one; skipped unless RECORDER_BOT_LIMITED_API_URL and the recorderBot.available \
expectation are set.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: capacity limit', () => {
    const apiUrl = config.recorderBot.limitedApiUrl;
    let running: string;
    let consultationId: string;

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason()
            ?? (apiUrl ? undefined : 'RECORDER_BOT_LIMITED_API_URL is not set');

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        expect((await getHealth(apiUrl)).maxConsultations).toBe(1);

        // Fill the service: nobody joins, so this consultation runs until the first-join wait ends it.
        running = uniqueHn('FULL');

        const { body, status } = await postConsultation(running, apiUrl);

        expect(status).toBe(201);
        consultationId = body.consultationId;
    });

    it('a request for another HN gets 503 and starts nothing', async () => {
        const other = uniqueHn('REFUSED');
        const refused = await postConsultation(other, apiUrl);

        expect(refused.status).toBe(503);
        expect((await getHealth(apiUrl)).activeConsultations).toBe(1);

        // No bot comes to the refused HN's room.
        const p1: Participant = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(other) });

        await p1.driver.pause(5_000);
        expect((await getHiddenView(p1)).hidden.length).toBe(0);
    });

    it('a repeated request for the running consultation still returns it', async () => {
        const again = await postConsultation(running, apiUrl);

        expect(again.status).toBe(200);
        expect(again.body.consultationId).toBe(consultationId);
    });
});
