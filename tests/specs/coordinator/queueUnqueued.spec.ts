import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getQueues,
    postStage,
    screenUrl,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A patient who is in their own room with no encounter is in no queue: the coordinator screen lists \
them in a strip above the board and in an item of the attention list, which leads to the strip. "เข้าคิว" asks which \
clinic, as the center has two, and starts their encounter in waiting with the picked one, which moves them from the \
strip to the board. Needs the test deployment\'s clinics "med" and "gyn". Skipped unless the deployment is the JWT \
variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: queueing a patient who has no encounter', () => {
    let screen: Participant;
    let room: string;

    /**
     * Reads the patient's card in the strip.
     *
     * @returns {Promise<string|undefined>} Its text, if the strip has one.
     */
    function stripCard(): Promise<string | undefined> {
        return screen.driver.execute((hn: string) => Array.from(document.querySelectorAll<HTMLElement>('.uq-card'))
            .find(card => card.dataset.hn === hn)?.innerText, room);
    }

    /**
     * Clicks the button of the patient's card in the strip, or a clinic of the choice it opens.
     *
     * @param {string} selector - Which button.
     * @returns {Promise<void>}
     */
    async function clickInStrip(selector: string) {
        await screen.driver.execute((hn: string, which: string) => {
            const card = Array.from(document.querySelectorAll<HTMLElement>('.uq-card')).find(c => c.dataset.hn === hn)!;

            card.querySelector<HTMLElement>(which)!.click();
        }, room, selector);
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn('UNQ');

        room = hn.toLowerCase();
        await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: `Patient ${uuidv4().slice(0, 8)}`,
                room: encodeURIComponent(room).toLowerCase(),
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        await waitForRoom(r => r !== undefined, hn, 'the patient\'s room');

        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(generateToken({
            displayName: 'ผู้ประสานงาน เข้าคิว',
            userClaims: { hospital_role: 'coordinator', id: `coordinator-${uuidv4()}` }
        }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
    });

    it('lists the patient in the strip above the board, with the button that queues them', async () => {
        await screen.driver.waitUntil(async () => await stripCard() !== undefined,
            { timeout: 15_000, timeoutMsg: 'the patient is not in the strip' });

        expect(await stripCard()).toContain('เข้าคิว');
        expect(await (await screen.driver.$('#unqueued')).isDisplayed()).toBe(true);
    });

    it('names them in an item of the attention list, which leads to the strip', async () => {
        const item = '#att-list .att-item[data-kind="unqueued"]';

        await screen.driver.waitUntil(() => screen.driver.execute(
            (selector: string, hn: string) => Boolean(document.querySelector(selector)?.textContent?.includes(hn)),
            item, room), { timeoutMsg: 'the attention list does not name the patient' });
        await (await screen.driver.$('#att-toggle')).click();
        await (await screen.driver.$(`${item} .att-open`)).click();

        await screen.driver.waitUntil(() => screen.driver.execute(
            () => Boolean(document.activeElement?.closest('#unqueued'))), { timeoutMsg: 'it did not lead to the strip' });
    });

    it('asks which clinic, and queues them in waiting at the one picked', async () => {
        await clickInStrip('.uq-go');

        // Another spec's patient may be in the strip too, with a choice of their own that stays closed.
        await (await screen.driver.$(`.uq-card[data-hn="${room}"] .uq-clinics button[data-clinic="gyn"]`))
            .waitForDisplayed({ timeout: 5_000 });
        expect((await getQueues()).waiting.some(e => e.hn?.toLowerCase() === room)).toBe(false);

        await clickInStrip('.uq-clinics button[data-clinic="gyn"]');

        await screen.driver.waitUntil(async () => await stripCard() === undefined,
            { timeout: 15_000, timeoutMsg: 'the patient is still in the strip' });

        const entry = (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === room)!;

        expect(entry).toBeDefined();

        const tag = await screen.driver.$(`#queue-waiting .queue-entry[data-encounter="${entry.encounterId}"] .badge.clinic`);

        await tag.waitForExist({ timeout: 10_000, timeoutMsg: 'the patient is not on the board' });
        expect(await tag.getText()).toBe('นรีเวช');

        // Nothing of this spec stays in the queues the others see.
        expect((await postStage(entry.encounterId, 'done')).status).toBe(200);
    });
});
