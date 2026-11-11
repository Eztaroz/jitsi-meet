import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { callCoordinator, coordinatorUnavailableReason, postEncounter } from '../../helpers/coordinator';
import { uniqueHn } from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The pipeline sets a recorder bot worker draining through the coordinator service: the worker list \
shows it, new consultations all go to the other worker, only the pipeline\'s secret can set or clear it, and clearing \
it brings the worker back (ADR 0014). Skipped unless the deployment has two recorder bot workers and \
COORDINATOR_PIPELINE_SECRET is set.',
    usesBrowsers: []
});

const DRAINED = 'recorder-bot-1';

describe('Coordinator: a draining worker', () => {
    const pipeline = config.coordinator.pipelineSecret;

    const setDraining = (draining: boolean, secret = pipeline) =>
        callCoordinator(`/workers/${DRAINED}/draining`, { body: JSON.stringify({ draining }), method: 'PUT' }, secret);
    const listed = async () => ((await (await callCoordinator('/workers')).json()) as {
        workers: { draining: boolean; id: string; }[];
    }).workers.find(w => w.id === DRAINED);
    const recordedBy = async (hn: string): Promise<string> => {
        const { body } = await postEncounter(hn);
        const response = await callCoordinator(`/encounters/${body.id}/consultations`);

        return ((await response.json()) as { consultations: { recorderBot: string; }[]; }).consultations[0].recorderBot;
    };

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason() ?? (pipeline ? undefined : 'COORDINATOR_PIPELINE_SECRET is not set');

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        // Both workers must be in service before the test means anything.
        for (let i = 0; i < 30; i++) {
            const workers = ((await (await callCoordinator('/workers')).json()) as {
                workers: { id: string; lost: boolean; }[];
            }).workers;

            if ([ 'recorder-bot-1', 'recorder-bot-2' ].every(id => workers.some(w => w.id === id && !w.lost))) {
                return;
            }
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
        throw new Error('the two recorder bot workers did not send heartbeats');
    });

    after(async () => {
        if (pipeline) {
            await setDraining(false);
        }
    });

    it('is refused to anyone but the pipeline', async () => {
        expect((await setDraining(true, config.coordinator.apiSecret)).status).toBe(403);
        expect((await setDraining(true, 'wrong')).status).toBe(401);
        expect((await listed())?.draining).toBe(false);
    });

    it('is shown as draining in the list of workers', async () => {
        expect((await setDraining(true)).status).toBe(200);
        expect((await listed())?.draining).toBe(true);
    });

    it('gets no new consultation: they all go to the other worker', async () => {
        for (const label of [ 'DRAIN1', 'DRAIN2' ]) {
            expect(await recordedBy(uniqueHn(label))).toBe('recorder-bot-2');
        }
    });

    it('takes work again when cleared', async () => {
        expect((await setDraining(false)).status).toBe(200);
        expect((await listed())?.draining).toBe(false);
    });
});
