import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import { callCoordinator, coordinatorUnavailableReason, postEncounter, screenUrl, waitForRoom } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'A coordinator signs in to the screen with a token from the hospital\'s issuer that carries the \
coordinator role marker; a token without it is refused, the shared bearer secret does not open the screen, and the \
screen shows nothing before sign-in. Signed in, the coordinator sees in Thai the queue of each stage with the time \
waited and the suggested patient, and the open rooms with who is in them, labelled as stations, lounges and patients\' \
rooms, with a patient\'s room that has no encounter marked. The screen refreshes by itself. Skipped unless the \
deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1', 'p2', 'p3' ]
});

describe('Coordinator: the screen', () => {
    const coordinatorId = `coordinator-${uuidv4()}`;
    let screen: Participant;
    let hnWith: string;
    let hnWithout: string;

    /**
     * Returns a token of the hospital's issuer for someone with a role.
     *
     * @param {string} role - Their role.
     * @param {string} id - Their id.
     * @param {string} name - Their name.
     * @returns {string}
     */
    function tokenOf(role: string, id: string, name: string): string {
        return generateToken({ displayName: name, userClaims: { hospital_role: role, id } }).jwt;
    }

    /**
     * Signs in on the screen.
     *
     * @param {string} token - The token.
     * @returns {Promise<void>}
     */
    async function signIn(token: string) {
        await (await screen.driver.$('#signin-token')).setValue(token);
        await (await screen.driver.$('#signin-submit')).click();
    }

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hnWith = uniqueHn('SCRWITH');
        hnWithout = uniqueHn('SCRWITHOUT');
        expect((await postEncounter(hnWith)).status).toBe(201);

        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
    });

    it('shows only the sign-in form before anyone has signed in', async () => {
        await (await screen.driver.$('#signin-token')).waitForDisplayed({ timeout: 10_000 });
        expect(await (await screen.driver.$('#board')).isDisplayed()).toBe(false);
        expect(await screen.driver.getTitle()).toContain('ศูนย์ควบคุม');
    });

    it('refuses a token without the coordinator role marker, in Thai', async () => {
        await signIn(tokenOf('staff', `staff-${uuidv4()}`, 'Staff S'));
        await (await screen.driver.$('#signin-error')).waitForDisplayed({ timeout: 10_000 });
        expect(await (await screen.driver.$('#signin-error')).getText()).toContain('ไม่ได้เป็นผู้ประสานงาน');
        expect(await (await screen.driver.$('#board')).isDisplayed()).toBe(false);
    });

    it('does not open the screen\'s data to the shared bearer secret, or to no one', async () => {
        const state = (secret?: string) => fetch(`${config.coordinator.apiUrl}/screen/api/state`, {
            headers: secret ? { 'Authorization': `Bearer ${secret}` } : {}
        });

        expect((await state()).status).toBe(401);
        expect((await state(config.coordinator.apiSecret)).status).toBe(403);
        expect((await callCoordinator('/screen/api/state')).status).toBe(403);
    });

    it('signs a coordinator in, and shows who', async () => {
        await signIn(tokenOf('coordinator', coordinatorId, 'ผู้ประสานงาน ก'));
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });
        expect(await (await screen.driver.$('#who-name')).getText()).toBe('ผู้ประสานงาน ก');
    });

    it('shows the queue of each stage, with the patient waiting and who is suggested', async () => {
        for (const stage of [ 'waiting', 'intake', 'examination', 'aftercare' ]) {
            expect(await (await screen.driver.$(`#queue-${stage}`)).isExisting()).toBe(true);
        }
        await screen.driver.waitUntil(async () => (await (await screen.driver.$('#queue-waiting')).getText()).includes(hnWith),
            { timeoutMsg: 'the patient is not in the waiting queue' });
        expect(await (await screen.driver.$('#queue-waiting')).getText()).toContain('รอคิว');
        expect(await (await screen.driver.$('.queue-entry.suggested')).isExisting()).toBe(true);
    });

    it('shows the open rooms, labelled, and refreshes by itself when someone joins', async () => {
        const patient = (id: string, name: string, hn: string, browser: string) => joinMuc({
            name: browser,
            token: generateToken({ displayName: name, userClaims: { ...expectations.recorderBot.patientClaims, id } })
        }, { roomName: patientLinkRoom(hn) });

        await patient(`patient-${uuidv4()}`, 'Patient A', hnWith, 'p2');
        await waitForRoom(r => r !== undefined, hnWith, 'the patient\'s room');

        await screen.driver.waitUntil(async () => (await (await screen.driver.$('#rooms')).getText()).includes('Patient A'),
            { timeout: 15_000, timeoutMsg: 'the room did not appear on the screen' });

        // A patient in a room that has no encounter.
        await patient(`patient-${uuidv4()}`, 'Patient B', hnWithout, 'p3');
        await screen.driver.waitUntil(async () => (await (await screen.driver.$('#rooms')).getText()).includes('Patient B'),
            { timeout: 15_000, timeoutMsg: 'the second room did not appear' });

        const text = await screen.driver.execute(() => Array.from(document.querySelectorAll('.room')).map(e => (e as HTMLElement).innerText));
        const without = text.find(t => t.includes('Patient B'))!;
        const withEncounter = text.find(t => t.includes('Patient A'))!;

        expect(without).toContain('ยังไม่มี encounter');
        expect(withEncounter).not.toContain('ยังไม่มี encounter');
        expect(withEncounter).toContain('ห้องผู้ป่วย');
        expect(withEncounter).toContain('ผู้ป่วย');
        expect(text.some(t => t.includes('intake-1') && t.includes('จุดบริการ') && t.includes('ปิดอยู่'))).toBe(true);
        expect(text.some(t => t.includes('lounge-1') && t.includes('ห้องพักเจ้าหน้าที่'))).toBe(true);
    });

    it('goes back to the sign-in form when the coordinator signs out', async () => {
        await (await screen.driver.$('#sign-out')).click();
        await (await screen.driver.$('#signin-token')).waitForDisplayed({ timeout: 10_000 });
        expect(await (await screen.driver.$('#board')).isDisplayed()).toBe(false);
    });
});
