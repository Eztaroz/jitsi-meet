import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { joinMuc } from '../../helpers/joinMuc';
import {
    getHiddenView,
    getJoinNotifications,
    patientLinkRoom,
    recorderBotUnavailableReason,
    startConsultation,
    uniqueHn,
    waitForConsultation,
    waitForHiddenParticipant,
    waitForRecordingLabel,
    watchJoinNotifications
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'Every participant sees the recording label while the recorder bot is in the room: a patient who \
joins after the bot, staff who join later, and participants who join while others are there. The label does not \
make the bot visible. Skipped unless the recorderBot.available expectation is set.',
    usesBrowsers: [ 'p1', 'p2', 'p3' ]
});

/** How many times staff leave and join again, so that a join race cannot pass by luck. */
const STAFF_REJOINS = 3;

describe('Recorder bot: recording label', () => {
    let p1: Participant, p3: Participant;
    let consultationId: string;
    let room: string;

    /**
     * Asserts that a participant sees the bot only as a hidden participant, among the given number of others.
     *
     * @param {Participant} participant - The participant.
     * @param {number} others - The humans other than the participant.
     * @returns {Promise<void>}
     */
    async function expectBotHidden(participant: Participant, others: number) {
        const view = await getHiddenView(participant);

        expect(view.hidden.length).toBe(1);
        expect(view.remote).toBe(others);
        expect(await participant.getFilmstrip().countVisibleThumbnails()).toBe(others + 1);
    }

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn();

        room = patientLinkRoom(hn);
        consultationId = (await startConsultation(hn)).consultationId;
        await waitForConsultation(consultationId, c => c.status === 'waiting_for_participants', {
            description: 'the bot to be in the room'
        });
    });

    it('a patient who joins after the bot sees the label', async () => {
        p1 = await joinMuc({ name: 'p1' }, { roomName: room });
        await watchJoinNotifications(p1);
        await waitForHiddenParticipant(p1);
        await waitForRecordingLabel(p1, consultationId);
        await expectBotHidden(p1, 0);
    });

    it('staff who join later see the label, every time they join', async () => {
        for (let join = 1; join <= STAFF_REJOINS; join++) {
            const staff = await joinMuc({ name: 'p2' }, { roomName: room });

            await waitForHiddenParticipant(staff);
            await waitForRecordingLabel(staff, consultationId);
            await staff.driver.waitUntil(async () => (await getHiddenView(staff)).remote === 1, {
                timeout: 10_000,
                timeoutMsg: 'p2 does not see p1'
            });
            await expectBotHidden(staff, 1);

            if (join < STAFF_REJOINS) {
                await staff.hangup();
            }
        }

        // The patient kept the label throughout.
        await waitForRecordingLabel(p1, consultationId);
    });

    it('a participant who joins while others are in the room sees the label', async () => {
        p3 = await joinMuc({ name: 'p3' }, { roomName: room });
        await waitForHiddenParticipant(p3);
        await waitForRecordingLabel(p3, consultationId);
        await p3.driver.waitUntil(async () => (await getHiddenView(p3)).remote === 2, {
            timeout: 10_000,
            timeoutMsg: 'p3 does not see p1 and p2'
        });
        await expectBotHidden(p3, 2);
    });

    it('nobody was shown the bot joining', async () => {
        await p1.driver.waitUntil(async () => (await getHiddenView(p1)).remote === 2, {
            timeout: 10_000,
            timeoutMsg: 'p1 does not see p2 and p3'
        });
        await expectBotHidden(p1, 2);

        // Join notifications name who joined; p1 was told about p2's joins and p3's, and never about the bot.
        const named = (await getJoinNotifications(p1)).map(n => JSON.parse(n));

        expect(named.length).toBeGreaterThan(0);
        for (const args of named) {
            expect(Object.values(args).every(name => name === 'p2' || name === 'p3')).toBe(true);
        }
    });
});
