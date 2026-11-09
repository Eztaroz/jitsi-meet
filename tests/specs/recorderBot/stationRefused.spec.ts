import { setTestProperties } from '../../helpers/TestProperties';
import { recorderBotUnavailableReason, postStationConsultation, uniqueHn } from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'A request that still sends station fields (room, patient) is refused with a clear error and no \
consultation starts (ADR 0011). Skipped unless the recorderBot.available expectation is set.',
    usesBrowsers: []
});

describe('Recorder bot: station fields are refused', () => {
    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;
        }
    });

    it('answers 400 and names ADR 0011', async () => {
        const { body, status } = await postStationConsultation(uniqueHn(), 'some-station', 'someone');

        expect(status).toBe(400);
        expect(JSON.stringify(body)).toContain('ADR 0011');
    });
});
