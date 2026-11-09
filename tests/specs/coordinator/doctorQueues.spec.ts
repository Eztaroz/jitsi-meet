import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import {
    coordinatorUnavailableReason,
    getAudit,
    getExamination,
    postDoctor,
    postEncounter,
    postStage,
    screenUrl
} from '../../helpers/coordinator';
import { joinMuc } from '../../helpers/joinMuc';
import { uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'Examination has a queue per doctor. The hospital\'s system sets an encounter\'s doctor through the \
API, and an unknown encounter is refused. The coordinator\'s screen shows the examination queue split by doctor, with \
the patients who have no doctor listed as unassigned, and the coordinator changes a patient\'s doctor from the screen; \
the change is attributed to the coordinator in the audit log. Skipped unless the deployment is the JWT variant of the \
recorder bot\'s test deployment with the coordinator service on top of it.',
    usesBrowsers: [ 'p1' ]
});

describe('Coordinator: per-doctor examination queues', () => {
    const coordinator = { id: `coordinator-${uuidv4()}`, name: 'ผู้ประสานงาน' };
    const doctorA = `doctor-a-${uuidv4()}`;
    const doctorB = `doctor-b-${uuidv4()}`;
    let screen: Participant;
    let assigned: string;
    let unassigned: string;
    let hnAssigned: string;
    let hnUnassigned: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hnAssigned = uniqueHn('DOCA');
        hnUnassigned = uniqueHn('DOCU');
        assigned = (await postEncounter(hnAssigned)).body.id;
        unassigned = (await postEncounter(hnUnassigned)).body.id;
        await postStage(assigned, 'examination');
        await postStage(unassigned, 'examination');
    });

    it('lets the hospital\'s system set a doctor, and refuses an unknown encounter', async () => {
        expect((await postDoctor(assigned, doctorA)).status).toBe(200);
        expect((await postDoctor('no-such-encounter', doctorA)).status).toBe(404);

        const examination = await getExamination();

        expect(examination.doctors[doctorA].map(e => e.encounterId)).toEqual([ assigned ]);
        expect(examination.unassigned.some(e => e.encounterId === unassigned)).toBe(true);
    });

    it('shows the queue split by doctor on the screen, and lets the coordinator change the doctor', async () => {
        screen = await joinMuc({ name: 'p1', token: generateToken({ displayName: 'x' }) }, { roomName: `scratch-${uuidv4()}` });
        await screen.driver.url(screenUrl());
        await (await screen.driver.$('#signin-token')).setValue(
            generateToken({ displayName: coordinator.name, userClaims: { hospital_role: 'coordinator', id: coordinator.id } }).jwt);
        await (await screen.driver.$('#signin-submit')).click();
        await (await screen.driver.$('#board')).waitForDisplayed({ timeout: 10_000 });

        const groupOf = (encounterId: string) => screen.driver.execute((id: string) => {
            const row = Array.from(document.querySelectorAll('#queue-examination .queue-entry'))
                .find(e => (e as HTMLElement).dataset.encounter === id);

            return row ? (row.closest('.doctor-group') as HTMLElement).dataset.doctor : undefined;
        }, encounterId);

        await screen.driver.waitUntil(async () => await groupOf(assigned) === doctorA,
            { timeoutMsg: 'the patient is not under their doctor' });
        expect(await groupOf(unassigned)).toBe('');

        await screen.driver.execute((id: string, doctor: string) => {
            const row = Array.from(document.querySelectorAll('#queue-examination .queue-entry'))
                .find(e => (e as HTMLElement).dataset.encounter === id)!;
            const controls = row.parentElement!.querySelector('.doctor-controls') as HTMLElement;
            const input = controls.querySelector('input') as HTMLInputElement;

            input.value = doctor;
            input.dispatchEvent(new Event('input'));
            (controls.querySelector('.doctor-set') as HTMLElement).click();
        }, unassigned, doctorB);

        await screen.driver.waitUntil(async () => await groupOf(unassigned) === doctorB,
            { timeoutMsg: 'the doctor was not changed on the screen' });
        expect((await getAudit(1000)).find(e => e.kind === 'doctor' && e.encounterId === unassigned && e.doctor === doctorB)?.issuer)
            .toBe(coordinator.id);
    });
});
