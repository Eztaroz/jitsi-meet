import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getAudit,
    getQueues,
    screenUrl,
    waitForRoom,
    withServiceLog
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator acts from the screen: starts an encounter for a patient\'s room that has none, \
changes an encounter\'s stage and marks it done, and moves a staff member from their lounge into a patient\'s room. \
A patient is offered no move, since patients stay in their own room (ADR 0011). A staff member being moved shows as \
moving on every coordinator\'s screen, and what came of the move is shown in Thai with its reason: cancelled by the \
staff member, refused. Every action is attributed in the audit log to the coordinator who made it, not to the system. \
Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service \
on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3', 'p4' ]
});

const LOUNGE = 'lounge-intake';

describe('Coordinator: acting from the screen', () => {
    const coordinatorA = { id: `coordinator-a-${uuidv4()}`, name: 'ผู้ประสานงาน เอ' };
    const coordinatorB = { id: `coordinator-b-${uuidv4()}`, name: 'ผู้ประสานงาน บี' };
    // The screen shows every recent move, other specs' too: a name of its own tells this one's.
    const patient = { id: `patient-${uuidv4()}`, name: `Patient ${uuidv4().slice(0, 8)}` };
    const nurse = { id: `nurse-${uuidv4()}`, name: `Nurse ${uuidv4().slice(0, 8)}` };
    let hn: string;
    let a: Participant;
    let b: Participant;
    let nurseBrowser: Participant;

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
                room: encodeURIComponent(hn.toLowerCase()).toLowerCase(),
                userClaims: { ...expectations.recorderBot.patientClaims, id: patient.id }
            })
        }, { roomName: patientLinkRoom(hn) });
        a = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        b = await joinMuc({ name: 'p2', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        nurseBrowser = await joinMuc({
            name: 'p3',
            token: generateToken({
                displayName: nurse.name,
                userClaims: { ...expectations.recorderBot.staffClaims, id: nurse.id }
            })
        }, { roomName: LOUNGE });
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

    it('offers a patient no move, and offers staff the patients\' rooms and the lounges', async () => {
        const room = hn.toLowerCase();

        await a.driver.waitUntil(async () => (await roomText(a, LOUNGE)).includes(nurse.name),
            { timeoutMsg: 'the nurse is not shown in the lounge' });
        await a.driver.waitUntil(async () => (await roomText(a, room)).includes(patient.name));

        const choices = await a.driver.execute((patientRoom: string, lounge: string, who: string) => {
            const card = (name: string) => Array.from(document.querySelectorAll('.room'))
                .find(e => (e as HTMLElement).dataset.room === name)!;
            const patientLine = card(patientRoom).querySelector('.occupant[data-role="patient"]')!;
            const nurseLine = Array.from(card(lounge).querySelectorAll('.occupant[data-role="staff"]'))
                .find(e => (e as HTMLElement).innerText.includes(who))!;

            return {
                patient: patientLine.querySelector('.move') !== null,
                staff: {
                    hasTypedHn: nurseLine.querySelector('.move-hn') !== null,
                    values: Array.from(nurseLine.querySelectorAll('select.move-to option'))
                        .map(o => (o as HTMLOptionElement).value)
                        .filter(Boolean)
                }
            };
        }, room, LOUNGE, nurse.name);

        // Patients stay in their own room (ADR 0011).
        expect(choices.patient).toBe(false);
        expect(choices.staff.hasTypedHn).toBe(true);
        expect(choices.staff.values).toContain(room);
        expect(choices.staff.values).toContain('lounge-aftercare');
        expect(choices.staff.values).not.toContain(LOUNGE);
    });

    it('moves a staff member into the patient\'s room: both screens show them moving, and they can cancel', async () => {
        await a.driver.execute((lounge: string, who: string, to: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === lounge)!;
            const line = Array.from(card.querySelectorAll('.occupant[data-role="staff"]'))
                .find(e => (e as HTMLElement).innerText.includes(who))!;
            const select = line.querySelector('select.move-to') as HTMLSelectElement;

            select.value = to;
            select.dispatchEvent(new Event('change'));
            (line.querySelector('.move-go') as HTMLElement).click();
        }, LOUNGE, nurse.name, hn.toLowerCase());

        await withServiceLog(() => Promise.all([ a, b ].map(screen => screen.driver.waitUntil(
            async () => (await roomText(screen, LOUNGE)).includes('กำลังย้าย'),
            { interval: 200, timeout: 8_000, timeoutMsg: 'the move is not shown on a screen' }))));

        await (await nurseBrowser.driver.$('#coordinator-move-cancel')).waitForExist({ timeout: 30_000 });
        await (await nurseBrowser.driver.$('#coordinator-move-cancel')).click();

        for (const screen of [ a, b ]) {
            await screen.driver.waitUntil(
                async () => (await (await screen.driver.$('#outcomes')).getText()).includes(`${nurse.name}: ผู้ถูกย้ายกดยกเลิก`),
                { timeout: 15_000, timeoutMsg: 'the cancellation is not shown' });
        }
    });

    it('shows a refused move with its reason in Thai', async () => {
        await b.driver.waitUntil(async () => !(await roomText(b, LOUNGE)).includes('กำลังย้าย'),
            { timeout: 15_000, timeoutMsg: 'the nurse is still shown moving' });
        await b.driver.execute((lounge: string, who: string, to: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === lounge)!;
            const line = Array.from(card.querySelectorAll('.occupant[data-role="staff"]'))
                .find(e => (e as HTMLElement).innerText.includes(who))!;
            const typed = line.querySelector('.move-hn') as HTMLInputElement;

            // A patient's room that nobody is in is closed: a staff member cannot be sent into it.
            typed.value = to;
            typed.dispatchEvent(new Event('input'));
            (line.querySelector('.move-go') as HTMLElement).click();
        }, LOUNGE, nurse.name, `closed-${uuidv4()}`);

        await b.driver.waitUntil(async () => (await (await b.driver.$('#notice')).getText()).includes('ห้องปลายทางยังไม่เปิด'),
            { timeout: 10_000, timeoutMsg: 'the reason is not shown' });
    });

    it('names the coordinator in the audit log for what they did, not the system', async () => {
        const entries = await getAudit(1000);
        const mine = entries.filter(e => e.kind === 'move' && e.participantId === nurse.id);

        expect(mine.length).toBe(2);
        expect(mine.find(e => e.outcome === 'cancelled')?.issuer).toBe(coordinatorA.id);
        expect(mine.find(e => e.outcome === 'refused')?.issuer).toBe(coordinatorB.id);
    });
});
