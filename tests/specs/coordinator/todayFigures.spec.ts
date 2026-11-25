import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    postEncounter,
    postStage,
    screenUrl
} from '../../helpers/coordinator';
import { joinMuc } from '../../helpers/joinMuc';
import { uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator sees how the day is going on the screen: the button above the board counts the \
encounters done today and opens and closes today\'s figures, every bar of their charts says its value, and the figures \
follow the clinic filter. Needs the test deployment\'s clinics "med" and "gyn". Skipped unless the deployment is the \
JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1' ]
});

describe('Coordinator: today\'s figures', () => {
    let screen: Participant;
    let gyn: string;
    let med: string;

    const find = (selector: string) => screen.driver.$(selector);
    const click = async (selector: string) => (await find(selector)).click();

    /** Today's completions, as the button says them. */
    const done = async () => Number(/เสร็จ (\d+)/.exec(await (await find('#today-toggle')).getText())?.[1] ?? NaN);

    const waitForDone = (atLeast: number) => screen.driver.waitUntil(
        async () => await done() >= atLeast,
        { timeout: 10_000, timeoutMsg: `the button never counted ${atLeast} done today` });

    /** Waits until the figures shown are of a clinic, '' being all of them. */
    const waitForClinic = (clinic: string) => screen.driver.waitUntil(
        async () => await (await find('#today')).getAttribute('data-clinic') === clinic,
        { timeout: 10_000, timeoutMsg: `the figures never followed "${clinic}"` });

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        gyn = (await postEncounter(uniqueHn('TODAYGYN'), { clinic: 'gyn' })).body.id;
        med = (await postEncounter(uniqueHn('TODAYMED'), { clinic: 'med' })).body.id;

        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await find('#signin-token')).setValue(generateToken({
            displayName: 'ผู้ประสานงาน สถิติ',
            userClaims: { hospital_role: 'coordinator', id: `coordinator-${uuidv4()}` }
        }).jwt);
        await click('#signin-submit');
        await (await find('#board')).waitForDisplayed({ timeout: 10_000 });
        await waitForClinic('');
    });

    it('counts the encounters done today on the button', async () => {
        const before = await done();

        expect((await postStage(med, 'done')).status).toBe(200);
        await waitForDone(before + 1);
    });

    it('opens today\'s figures, with a value on every bar and a legend for the two series', async () => {
        expect(await (await find('#today')).isDisplayed()).toBe(false);
        await click('#today-toggle');
        await (await find('#today')).waitForDisplayed();
        expect(await (await find('#today-toggle')).getAttribute('aria-expanded')).toBe('true');
        expect(await (await find('#today-done strong')).getText()).toBe(String(await done()));
        expect(await (await find('#today-average strong')).getText()).toContain('นาที');
        expect(await (await find('#today-longest strong')).getText()).toContain('นาที');
        expect(await (await find('#today .chart-legend')).getText()).toContain('เข้าใหม่');
        expect(await (await find('#today .chart-legend')).getText()).toContain('เสร็จ');

        const bars = await screen.driver.execute(() => {
            const values = (bar: string, value: string) => Array.from(document.querySelectorAll(bar))
                .map(b => b.querySelector(value)?.textContent ?? '');

            return {
                hours: values('#today-hours .hour-bar', '.hour-value'),
                stages: values('#today-stages .hbar', '.hbar-value')
            };
        });

        expect(bars.stages.length).toBeGreaterThan(0);
        expect(bars.hours.length).toBeGreaterThan(0);
        expect([ ...bars.stages, ...bars.hours ].filter(value => value === '')).toEqual([]);
    });

    it('closes them again', async () => {
        await click('#today-toggle');
        await (await find('#today')).waitForDisplayed({ reverse: true });
        expect(await (await find('#today-toggle')).getAttribute('aria-expanded')).toBe('false');
    });

    it('follows the clinic filter', async () => {
        await click('#today-toggle');

        const all = await done();

        await click('#clinic-filter button[data-clinic="gyn"]');
        await waitForClinic('gyn');

        // The other clinic's completion is not this one's.
        const ofClinic = await done();

        expect(ofClinic).toBeLessThan(all);
        expect(await (await find('#today-done strong')).getText()).toBe(String(ofClinic));

        // Nothing of this spec stays in the queues the others see.
        expect((await postStage(gyn, 'done')).status).toBe(200);
        await waitForDone(ofClinic + 1);

        await click('#clinic-filter button[data-clinic=""]');
        await waitForClinic('');
    });
});
