import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { joinMuc } from '../../helpers/joinMuc';
import {
    getHiddenView,
    patientLinkRoom,
    recorderBotUnavailableReason,
    startConsultation,
    waitForHiddenParticipant,
    waitForRecording,
    waitForStop
} from '../../helpers/recorderBot';

setTestProperties(__filename, {
    description: 'A patient whose HN has upper-case letters and a "/" opens their link and lands in the room the \
recorder bot records. Skipped unless the recorderBot.available expectation is set.',
    usesBrowsers: [ 'p1' ]
});

describe('Recorder bot: HN room', () => {
    let hn: string;
    let p1: Participant;

    it('setup', async () => {
        const unavailable = recorderBotUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = `AB/${ctx.roomName}/Cd`;
        p1 = await joinMuc({ name: 'p1' }, { roomName: patientLinkRoom(hn) });
    });

    it('the patient\'s link opens one room, not a room under a tenant', async () => {
        const [ roomNode, mucDomain ] = (await p1.execute(() => APP.conference._room.room.roomjid)).split('@');

        expect(roomNode).toBe(encodeURIComponent(hn.toLowerCase()).toLowerCase());
        expect(mucDomain).toBe(await p1.execute(() => config.hosts?.muc));
    });

    it('the bot joins that room', async () => {
        const { consultationId } = await startConsultation(hn);

        await waitForRecording(consultationId);
        await waitForHiddenParticipant(p1);
        expect((await getHiddenView(p1)).hidden.length).toBe(1);

        // Ending the meeting reaches the room too.
        await p1.getToolbar().clickEndMeetingForAllButton();
        expect((await waitForStop(consultationId)).stopReason).toBe('room_destroyed');
    });
});
