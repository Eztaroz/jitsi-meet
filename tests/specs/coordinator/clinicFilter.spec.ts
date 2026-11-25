import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getQueues,
    postEncounter,
    postStage,
    screenUrl
} from '../../helpers/coordinator';
import { joinMuc } from '../../helpers/joinMuc';
import { uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator of a center with several clinics follows one on the screen: the clinic bar counts each \
clinic\'s patients, picking one leaves only its cards on the board while the header\'s figures stay the center\'s, the \
cards name their clinic only while all are shown, and the pick survives a reload. A card sends its patient to the next \
stage of their own pathway, which may skip one. Needs the test deployment\'s clinics "med" and "gyn", the second with \
the pathway waiting, examination, done. Skipped unless the deployment is the JWT variant of the recorder bot\'s test \
deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1' ]
});

describe('Coordinator: the clinic filter', () => {
    let screen: Participant;
    let gyn: string;
    let med: string;

    const card = (id: string, stage = 'waiting') => `#queue-${stage} .queue-entry[data-encounter="${id}"]`;
    const choice = (clinic: string) => screen.driver.$(`#clinic-filter button[data-clinic="${clinic}"]`);
    const exists = async (selector: string) => (await screen.driver.$(selector)).isExisting();
    const waitForCard = async (selector: string) => (await screen.driver.$(selector))
        .waitForExist({ timeout: 10_000, timeoutMsg: `no card at ${selector}` });
    const tag = async (id: string) => await exists(`${card(id)} .badge.clinic`)
        ? (await screen.driver.$(`${card(id)} .badge.clinic`)).getText() : undefined;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        gyn = (await postEncounter(uniqueHn('CLINGYN'), { clinic: 'gyn' })).body.id;
        med = (await postEncounter(uniqueHn('CLINMED'), { clinic: 'med' })).body.id;

        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(generateToken({
            displayName: 'ผู้ประสานงาน คลินิก',
            userClaims: { hospital_role: 'coordinator', id: `coordinator-${uuidv4()}` }
        }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
        await waitForCard(card(med));
    });

    it('names each card\'s clinic while all clinics are shown, and counts each clinic\'s patients', async () => {
        expect(await (await choice('')).getAttribute('aria-pressed')).toBe('true');
        expect(await tag(gyn)).toBe('นรีเวช');
        expect(await tag(med)).toBe('อายุรกรรม');
        expect(Number(await (await choice('')).getAttribute('data-count')))
            .toBe(Object.values(await getQueues()).flat().length);
        expect(Number(await (await choice('gyn')).getAttribute('data-count'))).toBeGreaterThanOrEqual(1);
    });

    it('shows only the picked clinic\'s cards, without their tag, and keeps the header\'s figures', async () => {
        await (await choice('gyn')).click();

        await screen.driver.waitUntil(async () => !await exists(card(med)), { timeoutMsg: 'the other clinic is shown' });
        expect(await exists(card(gyn))).toBe(true);
        expect(await tag(gyn)).toBe(undefined);

        const shown = await screen.driver.execute(() => document.querySelectorAll('#queue-list .queue-entry').length);

        expect(shown).toBe(Number(await (await choice('gyn')).getAttribute('data-count')));
        expect(await (await screen.driver.$('#stat-waiting')).getText()).toBe(String((await getQueues()).waiting.length));
    });

    it('keeps the pick over a reload of the tab', async () => {
        await screen.driver.refresh();
        await waitForCard(card(gyn));

        expect(await (await choice('gyn')).getAttribute('aria-pressed')).toBe('true');
        expect(await exists(card(med))).toBe(false);
    });

    it('sends a patient to the next stage of their own pathway, past the stages it does not have', async () => {
        await (await screen.driver.$(`${card(gyn)} .card-go`)).click();

        await waitForCard(card(gyn, 'examination'));
        expect((await getQueues()).examination.some(e => e.encounterId === gyn)).toBe(true);
    });

    it('shows every clinic\'s cards again', async () => {
        await (await choice('')).click();

        await waitForCard(card(med));
        expect(await tag(med)).toBe('อายุรกรรม');

        // Nothing of this spec stays in the queues the others see.
        for (const id of [ gyn, med ]) {
            expect((await postStage(id, 'done')).status).toBe(200);
        }
    });
});
