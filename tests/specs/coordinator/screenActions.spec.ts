import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getAudit,
    getQueues,
    screenUrl,
    waitForRoom
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator acts from the screen: starts an encounter for a patient\'s room that has none, moves \
a patient to a station, changes an encounter\'s stage and marks it done. A participant being moved shows as \
moving on every coordinator\'s screen, and what came of the move is shown in Thai with its reason: cancelled by the \
participant, refused. Every action is attributed in the audit log to the coordinator who made it, not to the system. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3', 'p4' ]
});

describe('Coordinator: acting from the screen', () => {
    const coordinatorA = { id: `coordinator-a-${uuidv4()}`, name: 'ผู้ประสานงาน เอ' };
    const coordinatorB = { id: `coordinator-b-${uuidv4()}`, name: 'ผู้ประสานงาน บี' };
    // The screen shows every recent move, other specs' too: a name of its own tells this one's.
    const patient = { id: `patient-${uuidv4()}`, name: `Patient ${uuidv4().slice(0, 8)}` };
    let hn: string;
    let a: Participant;
    let b: Participant;
    let patientBrowser: Participant;

    /**
     * Opens the screen in a participant's browser and signs a coordinator in.
     *
     * @param {Participant} browser - The browser.
     * @param {Object} who - The coordinator.
     * @returns {Promise<void>}
     */
    async function openScreen(browser: Participant, who: { id: string; name: string; }) {
        await browser.driver.url(screenUrl());
        await (await browser.driver.$('#signin-token')).setValue(
            generateToken({ displayName: who.name, userClaims: { hospital_role: 'coordinator', id: who.id } }).jwt);
        await (await browser.driver.$('#signin-submit')).click();
        await (await browser.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
    }

    /**
     * Returns the text of the room card named so.
     *
     * @param {Participant} browser - Whose screen.
     * @param {string} room - The room.
     * @returns {Promise<string>}
     */
    function roomText(browser: Participant, room: string): Promise<string> {
        return browser.driver.execute((name: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === name);

            return card ? (card as HTMLElement).innerText : '';
        }, room);
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('ACT');
        patientBrowser = await joinMuc({
            name: 'p4',
            token: generateToken({
                displayName: patient.name,
                room: encodeURIComponent(hn.toLowerCase()).toLowerCase(),
                userClaims: { ...expectations.recorderBot.patientClaims, id: patient.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        a = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        b = await joinMuc({ name: 'p2', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        // A patient may be moved only into a station or their own room: a staff member keeps a station open for them.
        await joinMuc({
            name: 'p3',
            token: generateToken({
                displayName: 'Nurse N',
                userClaims: { ...expectations.recorderBot.staffClaims, id: `nurse-${uuidv4()}` }
            })
        }, { roomName: 'intake-1' });
        await openScreen(a, coordinatorA);
        await openScreen(b, coordinatorB);
        await waitForRoom(r => r !== undefined, hn, 'the patient\'s room');
    });

    it('starts an encounter for a patient\'s room that has none', async () => {
        const room = hn.toLowerCase();

        await a.driver.waitUntil(async () => (await roomText(a, room)).includes('ยังไม่มี encounter'));
        await a.driver.execute((name: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === name);

            (card!.querySelector('.start-encounter') as HTMLElement).click();
        }, room);

        await a.driver.waitUntil(async () => !(await roomText(a, room)).includes('ยังไม่มี encounter'),
            { timeout: 15_000, timeoutMsg: 'the encounter was not started' });
        expect((await getQueues()).waiting.some(e => e.hn?.toLowerCase() === room)).toBe(true);
    });

    it('changes an encounter\'s stage, and marks it done', async () => {
        const room = hn.toLowerCase();
        const entry = async () => (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === room)!;
        const id = (await entry()).encounterId;
        const act = (selector: string, value?: string) => a.driver.execute((encounterId: string, sel: string, v?: string) => {
            const row = Array.from(document.querySelectorAll('.queue-entry')).find(e => (e as HTMLElement).dataset.encounter === encounterId)!;
            const controls = row.nextElementSibling as HTMLElement;

            if (v) {
                const select = controls.querySelector('select') as HTMLSelectElement;

                select.value = v;
                select.dispatchEvent(new Event('change'));
            }
            (controls.querySelector(sel) as HTMLElement).click();
        }, id, selector, value);

        await a.driver.waitUntil(async () => await a.driver.$$('.queue-entry').length > 0);
        await act('.stage-go', 'intake');
        await a.driver.waitUntil(async () => (await getQueues()).intake.some(e => e.encounterId === id), { timeoutMsg: 'not in intake' });

        await a.driver.waitUntil(async () => await a.driver.$$('#queue-intake .queue-entry').length > 0);
        await act('.stage-done');
        await a.driver.waitUntil(
            async () => !Object.values(await getQueues()).flat().some(e => e.encounterId === id), { timeoutMsg: 'not done' });
        expect((await getAudit(1000)).find(e => e.kind === 'stage' && e.encounterId === id && e.to === 'done')?.issuer)
            .toBe(coordinatorA.id);
    });

    it('moves a patient to a station: both screens show them moving, and the participant can cancel', async () => {
        const room = hn.toLowerCase();
        const station = 'intake-1';

        await a.driver.waitUntil(async () => (await roomText(a, room)).includes(patient.name));
        await a.driver.waitUntil(
            async () => (await roomText(a, station)).length > 0, { timeoutMsg: 'the station is not shown' });
        await a.driver.execute((name: string, to: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === name)!;
            const select = card.querySelector('.occupant[data-role="patient"] select.move-to') as HTMLSelectElement;

            select.value = to;
            select.dispatchEvent(new Event('change'));
            (card.querySelector('.occupant[data-role="patient"] .move-go') as HTMLElement).click();
        }, room, station);

        // The recorder bot is asked to record the patient's time in the station before they are told.
        await Promise.all([ a, b ].map(screen => screen.driver.waitUntil(
            async () => (await roomText(screen, room)).includes('กำลังย้าย'),
            { interval: 200, timeout: 8_000, timeoutMsg: 'the move is not shown on a screen' })));

        await (await patientBrowser.driver.$('#coordinator-move-cancel')).waitForExist({ timeout: 30_000 });
        await (await patientBrowser.driver.$('#coordinator-move-cancel')).click();

        for (const screen of [ a, b ]) {
            await screen.driver.waitUntil(
                async () => (await (await screen.driver.$('#outcomes')).getText()).includes(`${patient.name}: ผู้ถูกย้ายกดยกเลิก`),
                { timeout: 15_000, timeoutMsg: 'the cancellation is not shown' });
        }
    });

    it('shows a refused move with its reason in Thai', async () => {
        await b.driver.waitUntil(async () => (await roomText(b, hn.toLowerCase())).includes(patient.name));
        await b.driver.execute((name: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === name)!;
            const select = card.querySelector('.occupant[data-role="patient"] select.move-to') as HTMLSelectElement;

            select.value = 'lounge-1';
            select.dispatchEvent(new Event('change'));
            (card.querySelector('.occupant[data-role="patient"] .move-go') as HTMLElement).click();
        }, hn.toLowerCase());

        await b.driver.waitUntil(async () => (await (await b.driver.$('#notice')).getText()).includes('ห้ามย้ายผู้ป่วยเข้าห้องพักเจ้าหน้าที่'),
            { timeout: 10_000, timeoutMsg: 'the reason is not shown' });
    });

    it('names the coordinator in the audit log for what they did, not the system', async () => {
        const entries = await getAudit(1000);
        const mine = entries.filter(e => e.kind === 'move' && e.participantId === patient.id);

        expect(mine.length).toBe(2);
        expect(mine.every(e => e.issuer === coordinatorA.id || e.issuer === coordinatorB.id)).toBe(true);
        expect(mine.find(e => e.outcome === 'cancelled')?.issuer).toBe(coordinatorA.id);
        expect(mine.find(e => e.outcome === 'refused')?.issuer).toBe(coordinatorB.id);
    });
});
