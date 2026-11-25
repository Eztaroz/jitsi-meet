import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    clickInPanel,
    coordinatorUnavailableReason,
    getAudit,
    getExamination,
    getQuestionnaires,
    getQueues,
    openEncounterPanel,
    postDoctor,
    postEncounter,
    postQuestionnaire,
    postStage,
    screenUrl,
    showScreenView,
    waitForRoom,
    withServiceLog
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { cancelMoveNotice } from '../../helpers/moveNotice';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator acts from the screen: starts an encounter for a patient\'s room that has none; \
in the panel a card opens, plays, stops and chooses a waiting video (where the deployment has a video player), sends \
a health questionnaire, picks a stage on the stepper, sets, takes away and picks a doctor, and marks an encounter \
done; sends the patient on from their card to the next stage, picks another stage for them, marks the encounter done \
from their card at the last stage, and moves a staff member from their lounge into a patient\'s room. \
The patient\'s card says that a health questionnaire waits for its answers, and then that it is answered. The header \
counts the moves under way, and its figure leads to the rooms and moves. \
The attention list counts what needs the coordinator, as the tab\'s title does; its items open the patient\'s panel, \
or the rooms for a move, and a refused move stays in it until it is dismissed, in that tab only. \
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
    let patientBrowser: Participant;

    // The room, which nobody is in, that coordinator B's refused move was to.
    const closedRoom = `closed-${uuidv4()}`;

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

    /**
     * Reads what the attention list and the tab's title count, at one moment.
     *
     * @param {Participant} browser - Whose screen.
     * @returns {Promise<Object>}
     */
    function attention(browser: Participant): Promise<{ count: string; items: string[]; title: string; }> {
        return browser.driver.execute(() => {
            return {
                count: document.querySelector('#att-count')?.textContent ?? '',
                items: Array.from(document.querySelectorAll('#att-list .att-item')).map(e => e.textContent ?? ''),
                title: document.title
            };
        });
    }

    /**
     * Expects the tab's title and the list's count to say how many items the list has.
     *
     * @param {Object} seen - What was read.
     * @returns {void}
     */
    function expectCounted({ count, items, title }: { count: string; items: string[]; title: string; }) {
        const name = 'หน้าจอผู้ประสานงาน';

        expect(count).toBe(String(items.length));
        expect(title).toBe(items.length ? `(${items.length}) ${name}` : name);
    }

    /**
     * Opens the attention list, if it is closed, and clicks a part of the item that says so.
     *
     * @param {Participant} browser - Whose screen.
     * @param {string} text - What the item says.
     * @param {string} part - Which part of it.
     * @returns {Promise<void>}
     */
    async function clickAttention(browser: Participant, text: string, part: '.att-dismiss' | '.att-open') {
        await showScreenView(browser, 'queue');
        await browser.driver.waitUntil(async () => (await attention(browser)).items.some(item => item.includes(text)),
            { timeout: 15_000, timeoutMsg: `the attention list has no item that says "${text}"` });

        const toggle = await browser.driver.$('#att-toggle');

        if (await toggle.getAttribute('aria-expanded') !== 'true') {
            await toggle.click();
        }
        await browser.driver.execute((says: string, selector: string) => {
            const item = Array.from(document.querySelectorAll('#att-list .att-item'))
                .find(e => e.textContent?.includes(says))!;

            (item.querySelector(selector) as HTMLElement).click();
        }, text, part);
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

        await showScreenView(a, 'rooms');
        await a.driver.waitUntil(async () => (await roomText(a, room)).includes('ยังไม่มี encounter'));
        await a.driver.execute((name: string) => {
            const card = Array.from(document.querySelectorAll('.room')).find(e => (e as HTMLElement).dataset.room === name);

            (card!.querySelector('.start-encounter') as HTMLElement).click();
        }, room);

        await a.driver.waitUntil(async () => !(await roomText(a, room)).includes('ยังไม่มี encounter'),
            { timeout: 15_000, timeoutMsg: 'the encounter was not started' });
        expect((await getQueues()).waiting.some(e => e.hn?.toLowerCase() === room)).toBe(true);
    });

    it('says on the card whether a health questionnaire waits for answers or is answered', async () => {
        const room = hn.toLowerCase();
        const id = (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === room)!.encounterId;
        const cardSays = (text: string) => a.driver.waitUntil(async () =>
            (await (await a.driver.$(`.queue-entry[data-encounter="${id}"]`)).getText()).includes(text),
        { timeout: 15_000, timeoutMsg: `the card does not say "${text}"` });

        await showScreenView(a, 'queue');
        expect((await postQuestionnaire(id, 'pain')).status).toBe(201);
        await cardSays('รอคำตอบแบบสอบถาม 1');

        // The one question of "pain".
        const overlay = await patientBrowser.driver.$('#coordinator-questionnaire');

        await overlay.waitForDisplayed({ timeout: 15_000 });
        await patientBrowser.driver.$('#coordinator-questionnaire-0-0').click();
        await patientBrowser.driver.$('#coordinator-questionnaire-submit').click();
        await cardSays('ตอบแบบสอบถามแล้ว');
    });

    it('closes an encounter\'s panel with its button, the Escape key and a click on the scrim', async () => {
        const id = (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === hn.toLowerCase())!.encounterId;
        const closed = async () => (await a.driver.$('.sheet')).waitForExist(
            { reverse: true, timeout: 5_000, timeoutMsg: 'the panel is still open' });

        await showScreenView(a, 'queue');
        await openEncounterPanel(a, id);
        await clickInPanel(a, '.sheet-close');
        await closed();

        await openEncounterPanel(a, id);
        await a.driver.keys('Escape');
        await closed();

        await openEncounterPanel(a, id);

        // The scrim's middle is left of the panel, which is on the right.
        await (await a.driver.$('#scrim')).click();
        await closed();
    });

    it('plays, stops and chooses a waiting video, and sends a questionnaire from the panel', async () => {
        const id = (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === hn.toLowerCase())!.encounterId;
        const videoAudit = async (action: string) => (await getAudit(1000)).find(
            e => e.kind === 'video' && e.encounterId === id && e.action === action && e.outcome === 'ok');

        await openEncounterPanel(a, id);
        if (process.env.VIDEO_PLAYER_AVAILABLE === 'true') {
            const toggleSays = (text: string) => a.driver.waitUntil(
                async () => (await (await a.driver.$('.sheet .video-toggle')).getText()) === text,
                { timeout: 15_000, timeoutMsg: `the video's button does not say ${text}` });

            await clickInPanel(a, '.video-toggle');
            await toggleSays('หยุด');
            await clickInPanel(a, '.video-toggle');
            await toggleSays('เล่น');

            await clickInPanel(a, '.video-play[data-video="second"]');
            await toggleSays('หยุด');
            expect((await videoAudit('play'))?.issuer).toBe(coordinatorA.id);
            await clickInPanel(a, '.video-toggle');
            await toggleSays('เล่น');
        }
        await clickInPanel(a, '.video-choose[data-video="second"]');
        await a.driver.waitUntil(async () => (await videoAudit('choose'))?.issuer === coordinatorA.id,
            { timeoutMsg: 'the video was not chosen' });

        const sent = async () => (await getQuestionnaires(id)).filter(q => q.questionnaire === 'pain').length;
        const before = await sent();

        await clickInPanel(a, '.questionnaire[data-questionnaire="pain"] .questionnaire-send');
        await a.driver.waitUntil(async () => await sent() === before + 1,
            { timeoutMsg: 'the questionnaire was not sent' });
        await a.driver.waitUntil(
            async () => (await (await a.driver.$('.sheet .questionnaire[data-questionnaire="pain"]')).getText())
                .includes('รอคำตอบ'),
            { timeoutMsg: 'the panel does not show the questionnaire waiting for answers' });
        await clickInPanel(a, '.sheet-close');
    });

    it('picks a stage, sets the doctor and marks an encounter done from the panel', async () => {
        const doctor = `doctor-${uuidv4()}`;
        const otherDoctor = `doctor-${uuidv4()}`;
        const id = (await postEncounter(uniqueHn('PANEL'))).body.id;
        const other = (await postEncounter(uniqueHn('PANELB'))).body.id;

        await postStage(other, 'examination');
        await postDoctor(other, otherDoctor);

        const doctorOf = async () => Object.entries((await getExamination()).doctors)
            .find(([ _, entries ]) => entries.some(e => e.encounterId === id))?.[0];

        await openEncounterPanel(a, id);
        await clickInPanel(a, '.step[data-stage="examination"] .step-pick');

        // The picked stage and the open panel survive the screen's refresh.
        await a.driver.pause(2500);
        await clickInPanel(a, '.stage-go');
        await a.driver.waitUntil(async () => (await getExamination()).unassigned.some(e => e.encounterId === id),
            { timeoutMsg: 'not sent to examination' });

        // The panel says how long the patient has been in the system, and how long the stage they left took; a new
        // encounter's card says nothing of it.
        const spent = await a.driver.$('.sheet .step[data-stage="waiting"] .step-time');

        await spent.waitForDisplayed({ timeout: 10_000, timeoutMsg: 'the past stage does not say how long it took' });
        expect(await spent.getText()).toContain('นาที');
        expect(await (await a.driver.$('.sheet [data-fact="total"] dd')).getText()).toContain('นาที');
        expect(await (await a.driver.$(`.queue-entry[data-encounter="${id}"] .badge.total`)).isExisting()).toBe(false);

        await (await a.driver.$('.sheet .doctor-to')).waitForDisplayed({ timeout: 10_000 });
        await (await a.driver.$('.sheet .doctor-to')).setValue(doctor);
        await a.driver.pause(2500);
        expect(await (await a.driver.$('.sheet .doctor-to')).getValue()).toBe(doctor);
        await clickInPanel(a, '.doctor-set');
        await a.driver.waitUntil(async () => await doctorOf() === doctor, { timeoutMsg: 'the typed doctor was not set' });

        await clickInPanel(a, '.doctor-chip[data-doctor=""]');
        await a.driver.waitUntil(async () => await doctorOf() === undefined,
            { timeoutMsg: 'the doctor was not taken away' });

        await clickInPanel(a, `.doctor-chip[data-doctor="${otherDoctor}"]`);
        await a.driver.waitUntil(async () => await doctorOf() === otherDoctor,
            { timeoutMsg: 'the picked doctor was not set' });

        // The panel still names the doctor once the patient has left examination.
        await clickInPanel(a, '.step[data-stage="aftercare"] .step-pick');
        await clickInPanel(a, '.stage-go');
        await a.driver.waitUntil(
            async () => await (await a.driver.$('.sheet[data-key^="aftercare|"] [data-fact="doctor"] dd')).isExisting()
                && await (await a.driver.$('.sheet [data-fact="doctor"] dd')).getText() === otherDoctor,
            { timeout: 10_000, timeoutMsg: 'the panel does not name the doctor after examination' });

        await clickInPanel(a, '.stage-done');
        await a.driver.waitUntil(
            async () => !Object.values(await getQueues()).flat().some(e => e.encounterId === id),
            { timeoutMsg: 'not done' });

        // An encounter that is done has no panel any more.
        await (await a.driver.$('.sheet')).waitForExist({ reverse: true, timeout: 10_000 });
        await postStage(other, 'done');
    });

    it('sends a patient on from their card, to a picked stage, and marks it done at the last stage', async () => {
        const room = hn.toLowerCase();
        const entry = async () => (await getQueues()).waiting.find(e => e.hn?.toLowerCase() === room)!;
        const id = (await entry()).encounterId;
        const face = (stage: string) => `#queue-${stage} .queue-entry[data-encounter="${id}"]`;

        // The card's one action, in the column of the stage the patient is in.
        const forward = async (stage: string) => {
            const go = await a.driver.$(`${face(stage)} .card-go`);

            await go.waitForExist({ timeout: 10_000, timeoutMsg: `the patient has no card in ${stage}` });
            await go.click();
        };
        const inStage = (stage: string) => a.driver.waitUntil(
            async () => (await getQueues())[stage].some(e => e.encounterId === id), { timeoutMsg: `not in ${stage}` });

        await showScreenView(a, 'queue');
        await forward('waiting');
        await inStage('registration');

        // Any other stage is picked on the stepper of the encounter's panel.
        await (await a.driver.$(face('registration'))).waitForExist({ timeout: 10_000 });
        await openEncounterPanel(a, id);
        await clickInPanel(a, '.step[data-stage="pharmacy"] .step-pick');
        await clickInPanel(a, '.stage-go');
        await inStage('pharmacy');
        await clickInPanel(a, '.sheet-close');

        await forward('pharmacy');
        await a.driver.waitUntil(
            async () => !Object.values(await getQueues()).flat().some(e => e.encounterId === id), { timeoutMsg: 'not done' });
        expect((await getAudit(1000)).find(e => e.kind === 'stage' && e.encounterId === id && e.to === 'done')?.issuer)
            .toBe(coordinatorA.id);
    });

    it('offers a patient no move, and offers staff the patients\' rooms and the lounges', async () => {
        const room = hn.toLowerCase();

        await showScreenView(a, 'rooms');
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

        await showScreenView(b, 'rooms');
        await withServiceLog(() => Promise.all([ a, b ].map(screen => screen.driver.waitUntil(

            // The move in the lounge, and in the header's count, which other specs' moves may add to.
            async () => (await roomText(screen, LOUNGE)).includes('กำลังย้าย')
                && Number(await (await screen.driver.$('#stat-moving')).getText()) >= 1,
            { interval: 200, timeout: 8_000, timeoutMsg: 'the move is not shown on a screen' }))));

        await cancelMoveNotice(nurseBrowser);

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
        }, LOUNGE, nurse.name, closedRoom);

        await b.driver.waitUntil(async () => (await (await b.driver.$('#notice')).getText()).includes('ห้องปลายทางยังไม่เปิด'),
            { timeout: 10_000, timeoutMsg: 'the reason is not shown' });
    });

    it('counts a refused move in the attention list and the tab\'s title, and leads from it to the rooms', async () => {
        await clickAttention(b, closedRoom, '.att-open');
        await (await b.driver.$('#view-rooms')).waitForDisplayed({ timeout: 5_000 });

        const seen = await attention(b);

        expect(seen.items.length).toBeGreaterThan(0);
        expectCounted(seen);
    });

    it('keeps a dismissed move dismissed after a reload of the same tab, and shows it in another', async () => {
        const listed = async (browser: Participant) =>
            (await attention(browser)).items.some(item => item.includes(closedRoom));

        await clickAttention(b, closedRoom, '.att-dismiss');
        await b.driver.waitUntil(async () => !await listed(b), { timeoutMsg: 'the dismissed move is still listed' });
        expectCounted(await attention(b));

        await b.driver.refresh();
        await (await b.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
        await b.driver.waitUntil(async () => (await (await b.driver.$('#stat-rooms')).getText()) !== '0',
            { timeoutMsg: 'the screen did not draw the state after the reload' });
        expect(await listed(b)).toBe(false);
        expectCounted(await attention(b));

        // The other coordinator's screen has a tab of its own, which dismissed nothing.
        await a.driver.waitUntil(() => listed(a), { timeoutMsg: 'the move is not listed in the other tab' });
        expectCounted(await attention(a));
    });

    it('opens a patient\'s panel from an item of the attention list', async () => {
        const id = (await postEncounter(uniqueHn('ATTN'))).body.id;
        const noDoctor = 'ยังไม่มีแพทย์';

        await postStage(id, 'examination');

        // The item is the center's, so it may lead to another spec's patient with no doctor.
        await clickAttention(a, noDoctor, '.att-open');
        await (await a.driver.$('.sheet .doctor-to')).waitForDisplayed({ timeout: 10_000 });
        await clickInPanel(a, '.sheet-close');
        await postStage(id, 'done');
    });

    it('leads from the header\'s figure of moves to the rooms and moves', async () => {
        await showScreenView(a, 'queue');
        await (await a.driver.$('#stat-moves')).click();
        await (await a.driver.$('#view-rooms')).waitForDisplayed({ timeout: 5_000 });
    });

    it('names the coordinator in the audit log for what they did, not the system', async () => {
        const entries = await getAudit(1000);
        const mine = entries.filter(e => e.kind === 'move' && e.participantId === nurse.id);

        expect(mine.length).toBe(2);
        expect(mine.find(e => e.outcome === 'cancelled')?.issuer).toBe(coordinatorA.id);
        expect(mine.find(e => e.outcome === 'refused')?.issuer).toBe(coordinatorB.id);
    });
});
