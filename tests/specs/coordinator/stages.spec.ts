import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getEncounter,
    getQueues,
    postEncounter,
    postStage,
    restartCoordinator
} from '../../helpers/coordinator';
import { uniqueHn } from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'Encounters move through the stages by explicit commands: forward, skipping a stage, and back, and \
done closes the encounter. Each stage has a queue of the open encounters in it, the longest-waiting first, with the \
time waited and the first suggested. The stage history survives a restart of the service. Skipped unless the \
deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1' ]
});

describe('Coordinator: stages and queues', () => {
    let a: string;
    let b: string;
    let hnA: string;
    let hnB: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hnA = uniqueHn('STAGEA');
        hnB = uniqueHn('STAGEB');
        a = (await postEncounter(hnA)).body.id;
        await new Promise(resolve => setTimeout(resolve, 1_100));
        b = (await postEncounter(hnB)).body.id;
    });

    it('queues the patients waiting, the longest-waiting first and suggested, with the time they have waited', async () => {
        const queue = (await getQueues()).waiting;
        const mine = queue.filter(e => [ a, b ].includes(e.encounterId));

        // Other patients may be waiting too: only the first of the whole queue is suggested.
        expect(queue.map(e => e.suggested)).toEqual(queue.map((_, i) => i === 0));
        expect(queue.map(e => e.waitedSeconds)).toEqual([ ...queue.map(e => e.waitedSeconds) ].sort((x, y) => y - x));
        expect(mine.map(e => e.encounterId)).toEqual([ a, b ]);
        expect(mine[0].hn).toBe(hnA);
        expect(mine[0].waitedSeconds).toBeGreaterThanOrEqual(1);
        expect(mine[0].waitedSeconds).toBeGreaterThanOrEqual(mine[1].waitedSeconds);
    });

    it('moves an encounter on to the next stage, and into that stage\'s queue', async () => {
        expect((await postStage(a, 'intake')).body.stage).toBe('intake');

        const queues = await getQueues();

        expect(queues.waiting.some(e => e.encounterId === a)).toBe(false);
        expect(queues.intake.some(e => e.encounterId === a)).toBe(true);
    });

    it('skips a stage, and goes back to an earlier one', async () => {
        expect((await postStage(b, 'aftercare')).body.stage).toBe('aftercare');
        expect((await getQueues()).aftercare.some(e => e.encounterId === b)).toBe(true);
        expect((await postStage(b, 'waiting')).body.stage).toBe('waiting');
        expect((await getQueues()).waiting.some(e => e.encounterId === b)).toBe(true);
    });

    it('keeps the stage history across a restart of the service', async () => {
        await restartCoordinator();

        const { body } = await getEncounter(a);

        expect(body.stage).toBe('intake');
        expect(body.history?.map(h => h.stage)).toEqual([ 'waiting', 'intake' ]);
    });

    it('closes an encounter with done, which leaves every queue, and refuses any change after it', async () => {
        expect((await postStage(a, 'done')).body.stage).toBe('done');

        const queues = await getQueues();

        expect(Object.values(queues).flat().some(e => e.encounterId === a)).toBe(false);
        expect((await postStage(a, 'intake')).status).toBe(409);
    });

    it('refuses an unknown encounter and an unknown stage', async () => {
        expect((await postStage('nope', 'intake')).status).toBe(404);
        expect((await postStage(b, 'lunch')).status).toBe(400);
    });

    it('lets the patient start a new encounter once the last one is done', async () => {
        const again = await postEncounter(hnA);

        expect(again.status).toBe(201);
        expect(again.body.id).not.toBe(a);
    });
});
