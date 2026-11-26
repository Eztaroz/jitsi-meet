import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    clickInPanel,
    coordinatorUnavailableReason,
    openEncounterPanel,
    postEncounter,
    postStage,
    screenUrl
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The coordinator\'s screen warns about an encounter\'s room: a patient who is not in their own room \
has a greyed card with a badge, an alert in the panel and an item in the attention list, which go away while they are \
in the room; a room that is not being recorded has a badge and a red bar on its card, an alert and an item of its \
own. No recorder bot is without room in this deployment, so that last state is written into what the screen reads (the \
service\'s own flag is covered by its tests). Skipped unless the coordinator test deployment is up.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Coordinator: the screen warns about a patient\'s room', () => {
    let screen: Participant;
    let patient: Participant;
    let hn: string;
    let encounterId: string;

    const card = () => `.queue-entry[data-encounter="${encounterId}"]`;
    const has = (selector: string) => screen.driver.execute(
        (css: string) => document.querySelector(css) !== null, selector);
    const waitFor = (selector: string, there: boolean) => screen.driver.waitUntil(
        async () => await has(selector) === there,
        { timeout: 20_000, timeoutMsg: `${selector} is ${there ? 'not' : 'still'} on the screen` });

    /**
     * Whether the attention list has an item of a kind that names the patient.
     *
     * @param {string} kind - The kind of trouble.
     * @returns {Promise<boolean>}
     */
    function listed(kind: string): Promise<boolean> {
        return screen.driver.execute((what: string, who: string) => Array
            .from(document.querySelectorAll(`#att-list .att-item[data-kind="${what}"]`))
            .some(item => item.textContent?.includes(who)), kind, hn);
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('TROUBLE');
        encounterId = (await postEncounter(hn)).body.id;
        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(generateToken({
            displayName: 'ผู้ประสานงาน ห้อง',
            userClaims: { hospital_role: 'coordinator', id: `coordinator-${uuidv4()}` }
        }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
    });

    it('warns that a patient is not in their room before they have joined it', async () => {
        await waitFor(`${card()} .badge.not-in-room`, true);
        expect(await (await screen.driver.$(`${card()} .badge.not-in-room`)).getText()).toContain('คนไข้ไม่อยู่ในห้อง');
        expect(await has(`.ticket[data-not-in-room="true"] ${card()}`)).toBe(true);
        expect(await listed('not-in-room')).toBe(true);

        await openEncounterPanel(screen, encounterId);
        await waitFor('.sheet .sheet-alert[data-kind="not-in-room"]', true);
        await clickInPanel(screen, '.sheet-close');
    });

    it('takes the warning away once the patient is in their room', async () => {
        patient = await joinMuc({
            name: 'p2',
            token: generateToken({
                displayName: 'Patient T',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });

        await waitFor(`${card()} .badge.not-in-room`, false);
        expect(await has(`.ticket[data-not-in-room="false"] ${card()}`)).toBe(true);
        expect(await listed('not-in-room')).toBe(false);
        expect(await has(`${card()} .badge.unrecorded`)).toBe(false);
    });

    it('warns that the patient\'s room is not being recorded', async () => {
        // The screen's reads of the state, with the patient's room flagged as the service flags one.
        await screen.driver.execute((id: string) => {
            const real = window.fetch.bind(window);

            window.fetch = async (input, init) => {
                const response = await real(input, init);

                if (!String(input).endsWith('screen/api/state') || !response.ok) {
                    return response;
                }

                const state = await response.json();

                state.rooms.filter((r: { encounterId?: string; }) => r.encounterId === id)
                    .forEach((r: { unrecorded?: boolean; }) => {
                        r.unrecorded = true;
                    });

                return new Response(JSON.stringify(state), { headers: response.headers, status: response.status });
            };
        }, encounterId);

        await waitFor(`${card()} .badge.unrecorded`, true);
        expect(await (await screen.driver.$(`${card()} .badge.unrecorded`)).getText()).toContain('ไม่ได้บันทึกหลักฐาน');
        expect(await has(`.ticket[data-trouble="true"] ${card()}`)).toBe(true);
        expect(await listed('unrecorded')).toBe(true);

        await openEncounterPanel(screen, encounterId);
        await waitFor('.sheet .sheet-alert[data-kind="unrecorded"]', true);
        await clickInPanel(screen, '.sheet-close');
    });

    it('warns again once the patient has left their room', async () => {
        await patient.hangup();

        await waitFor(`${card()} .badge.not-in-room`, true);
        expect(await listed('not-in-room')).toBe(true);
        await postStage(encounterId, 'done');
    });
});
