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
    waitForHiddenParticipant,
    waitForRecording,
    waitForStop,
    watchJoinNotifications
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'The recorder bot joins a consultation unseen, is never a moderator, and stops when a moderator ends \
the meeting for everyone. Skipped unless the recorderBot.available expectation is set.',
    usesBrowsers: [ 'p1', 'p2' ]
});

describe('Recorder bot: hidden participant', () => {
    let p1: Participant, p2: Participant;
    let consultationId: string;
    let room: string;

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        const hn = uniqueHn();

        room = patientLinkRoom(hn);
        p1 = await joinMuc({ name: 'p1' }, { roomName: room });
        expect(await p1.isModerator()).toBe(true);
        await watchJoinNotifications(p1);

        consultationId = (await startConsultation(hn)).consultationId;
        await waitForRecording(consultationId);
        await waitForHiddenParticipant(p1);
    });

    it('a participant present when the bot joins does not see it', async () => {
        // Join notifications are batched for two seconds.
        await p1.driver.pause(3000);

        expect((await getHiddenView(p1)).remote).toBe(0);
        // The filmstrip shows p1's own thumbnail only.
        expect(await p1.getFilmstrip().countVisibleThumbnails()).toBe(1);
        expect(await getJoinNotifications(p1)).toEqual([]);
    });

    it('a participant joining later does not see it either', async () => {
        p2 = await joinMuc({ name: 'p2' }, { roomName: room });
        await waitForHiddenParticipant(p2);

        // p1 is told about p2, which shows that the notifications are watched.
        await p1.driver.waitUntil(async () => (await getJoinNotifications(p1)).length > 0, {
            timeout: 10_000,
            timeoutMsg: 'p1 was not told that p2 joined'
        });
        expect(await getJoinNotifications(p1)).toEqual([ JSON.stringify({ name: 'p2' }) ]);

        expect((await getHiddenView(p1)).remote).toBe(1);
        expect((await getHiddenView(p2)).remote).toBe(1);
        // Each shows its own thumbnail and the other's.
        await p1.driver.waitUntil(async () => await p1.getFilmstrip().countVisibleThumbnails() === 2, {
            timeout: 10_000,
            timeoutMsg: 'p1 does not show exactly its own and p2\'s thumbnails'
        });
        await p2.driver.waitUntil(async () => await p2.getFilmstrip().countVisibleThumbnails() === 2, {
            timeout: 10_000,
            timeoutMsg: 'p2 does not show exactly its own and p1\'s thumbnails'
        });
    });

    it('the bot never becomes a moderator', async () => {
        expect((await getHiddenView(p1)).hidden).toEqual([ { role: 'participant' } ]);
        expect(await p2.isModerator()).toBe(false);

        // With p1 gone, the moderator role goes to p2, not to the bot.
        await p1.hangup();
        await p2.driver.waitUntil(() => p2.isModerator(), {
            timeout: 10_000,
            timeoutMsg: 'p2 did not become moderator'
        });
        expect((await getHiddenView(p2)).hidden).toEqual([ { role: 'participant' } ]);
    });

    it('ending the meeting for everyone stops the bot', async () => {
        await p2.getToolbar().clickEndMeetingForAllButton();

        const consultation = await waitForStop(consultationId);

        expect(consultation.stopReason).toBe('room_destroyed');
    });
});
