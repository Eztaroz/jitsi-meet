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
a participant to a chosen room, changes an encounter\'s stage and marks it done. A participant being moved shows as \
moving on every coordinator\'s screen, and what came of the move is shown in Thai with its reason: cancelled by the \
participant, refused. Every action is attributed in the audit log to the coordinator who made it, not to the system. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3', 'p4' ]
});

describe('Coordinator: acting from the screen', () => {
    const coordinatorA = { id: `coordinator-a-${uuidv4()}`, name: 'ผู้ประสานงาน เอ' };
    const coordinatorB = { id: `coordinator-b-${uuidv4()}`, name: 'ผู้ประสานงาน บี' };
    const staff = { id: `staff-${uuidv4()}`, name: 'Staff S' };
    const patient = { id: `patient-${uuidv4()}`, name: 'Patient P' };
    let hn: string;
    let a: Participant;
    let b: Participant;
    let staffBrowser: Participant;

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
        await joinMuc({
            name: 'p4',
            token: generateToken({
                displayName: patient.name,
                userClaims: { ...expectations.recorderBot.patientClaims, id: patient.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        staffBrowser = await joinMuc({
            name: 'p3',
            token: generateToken({
                displayName: staff.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: staff.id }
            })
        }, { roomName: 'lounge-1' });
        a = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        b = await joinMuc({ name: 'p2', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
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

        await a.driver.waitUntil(async () => (await a.driver.$$('.queue-entry')).length > 0);
        await act('.stage-go', 'intake');
        await a.driver.waitUntil(async () => (await getQueues()).intake.some(e => e.encounterId === id), { timeoutMsg: 'not in intake' });

        await a.driver.waitUntil(async () => (await a.driver.$$('#queue-intake .queue-entry')).length > 0);
        await act('.stage-done');
        await a.driver.waitUntil(
            async () => !Object.values(await getQueues()).flat().some(e => e.encounterId === id), { timeoutMsg: 'not done' });
        expect((await getAudit()).find(e => e.kind === 'stage' && e.encounterId === id && e.to === 'done')?.issuer)
            .toBe(coordinatorA.id);
    });

    it('moves a participant to a chosen room: both screens show them moving, and the participant can cancel', async () => {
        const room = hn.toLowerCase();

        await a.driver.waitUntil(async () => (await roomText(a, 'lounge-1')).includes(staff.name));
        await a.driver.execute((to: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === 'lounge-1')!;
            const select = card.querySelector('.occupant[data-role="staff"] select.move-to') as HTMLSelectElement;

            select.value = to;
            select.dispatchEvent(new Event('change'));
            (card.querySelector('.occupant[data-role="staff"] .move-go') as HTMLElement).click();
        }, room);

        for (const screen of [ a, b ]) {
            await screen.driver.waitUntil(async () => (await roomText(screen, 'lounge-1')).includes('กำลังย้าย'),
                { timeout: 10_000, timeoutMsg: 'the move is not shown on a screen' });
        }

        await (await staffBrowser.driver.$('#coordinator-move-cancel')).waitForExist({ timeout: 10_000 });
        await (await staffBrowser.driver.$('#coordinator-move-cancel')).click();

        for (const screen of [ a, b ]) {
            await screen.driver.waitUntil(async () => (await (await screen.driver.$('#outcomes')).getText()).includes('ผู้ถูกย้ายกดยกเลิก'),
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
        const entries = await getAudit();
        const mine = entries.filter(e => e.kind === 'move' && [ staff.id, patient.id ].includes(e.participantId ?? ''));

        expect(mine.length).toBeGreaterThanOrEqual(2);
        expect(mine.every(e => e.issuer === coordinatorA.id || e.issuer === coordinatorB.id)).toBe(true);
        expect(mine.find(e => e.outcome === 'cancelled')?.issuer).toBe(coordinatorA.id);
        expect(mine.find(e => e.outcome === 'refused')?.issuer).toBe(coordinatorB.id);
    });
});
