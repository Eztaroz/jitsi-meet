import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { coordinatorUnavailableReason } from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import { patientLinkRoom, uniqueHn } from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The deployment is web only. A client that does not announce that it obeys moves, as the mobile apps \
and other clients do not, is refused when it tries to join, while the fork\'s web client is let in. Breakout rooms are \
disabled, so a moderator finds no button for one in the participants pane, and deep linking is off so that a phone \
opens the link in its browser. Skipped unless the deployment is the JWT variant of the recorder bot\'s test deployment with the coordinator \
service on top of it.',
    usesBrowsers: [ 'p1' ]
});

/**
 * Tries to join a room with a bare XMPP client over a websocket, from the page of a participant, the way a client
 * that is not the fork's web client would: with or without announcing that it obeys moves.
 *
 * @param {Participant} participant - Whose page opens the websocket.
 * @param {string} room - The room, as Prosody names it.
 * @param {string} jwt - The token.
 * @param {boolean} announce - Whether to announce move support.
 * @returns {Promise<string>} `joined`, `refused`, or what went wrong.
 */
function tryToJoin(participant: Participant, room: string, jwt: string, announce: boolean): Promise<string> {
    return participant.driver.executeAsync((r: string, token: string, support: boolean, done: (result: string) => void) => {
        const ws = new WebSocket(`wss://${location.host}/xmpp-websocket?room=${encodeURIComponent(r)}&token=${token}`, 'xmpp');
        const OPEN = '<open xmlns=\'urn:ietf:params:xml:ns:xmpp-framing\' to=\'meet.jitsi\' version=\'1.0\'/>';
        let step = 0;
        const timer = setTimeout(() => done(`timeout at step ${step}`), 20000);
        const finish = (result: string) => {
            clearTimeout(timer);
            ws.close();
            done(result);
        };

        ws.onerror = () => finish(`websocket error at step ${step}`);
        ws.onopen = () => ws.send(OPEN);
        ws.onmessage = e => {
            const m = String(e.data);

            if (step === 0 && m.includes('mechanisms')) {
                step = 1;
                ws.send('<auth xmlns=\'urn:ietf:params:xml:ns:xmpp-sasl\' mechanism=\'ANONYMOUS\'/>');
            } else if (step === 1 && m.includes('<success')) {
                step = 2;
                ws.send(OPEN);
            } else if (step === 2 && m.includes('urn:ietf:params:xml:ns:xmpp-bind')) {
                step = 3;
                ws.send('<iq type=\'set\' id=\'bind1\' xmlns=\'jabber:client\'><bind xmlns=\'urn:ietf:params:xml:ns:xmpp-bind\'/></iq>');
            } else if (step === 3 && m.includes('bind1')) {
                step = 4;
                ws.send(`<presence to='${r}@muc.meet.jitsi/barenick' xmlns='jabber:client'>`
                    + '<x xmlns=\'http://jabber.org/protocol/muc\'/>'
                    + `${support ? '<jitsi_participant_coordinatorMoveSupport xmlns=\'jabber:client\'>true</jitsi_participant_coordinatorMoveSupport>' : ''}`
                    + '</presence>');
            } else if (step === 4 && /type=['"]error['"]/u.test(m)) {
                finish(`refused: ${m}`);
            } else if (step === 4 && /code=['"]110['"]/u.test(m)) {
                finish('joined');
            }
        };
    }, room, jwt, announce);
}

describe('Coordinator: the web client only', () => {
    let host: Participant;
    let hn: string;
    let token: string;

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason();

        if (unavailable) {
            ctx.skipSuiteTests = unavailable;

            return;
        }

        hn = uniqueHn('WEBONLY');
        host = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: 'Staff S',
                userClaims: { ...expectations.recorderBot.staffClaims, id: `staff-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        token = generateToken({
            displayName: 'Other client',
            userClaims: { ...expectations.recorderBot.staffClaims, id: `other-${uuidv4()}` }
        }).jwt;
    });

    it('refuses a client that does not announce that it obeys moves', async () => {
        const room = encodeURIComponent(hn.toLowerCase()).toLowerCase();

        const result = await tryToJoin(host, room, token, false);

        expect(result).toMatch(/^refused/u);
        expect(result).toContain('not-allowed');
        expect(result).toContain('cannot be moved');
    });

    it('lets in a client that announces it, which is what the fork\'s web client does', async () => {
        const room = encodeURIComponent(hn.toLowerCase()).toLowerCase();

        expect(await tryToJoin(host, room, token, true)).toBe('joined');
        expect(await host.isInMuc()).toBe(true);
    });

    it('has the web client announce it in its first presence', async () => {
        const announced = await host.execute(() => APP.conference._room.room.presMap.nodes
            .some((n: { tagName?: string; }) => n.tagName === 'jitsi_participant_coordinatorMoveSupport'));

        expect(announced).toBe(true);
    });

    it('has breakout rooms disabled: none can be created', async () => {
        expect(await host.execute(() => APP.conference._room.getBreakoutRooms().isSupported())).toBe(false);
        expect(await host.execute(() => APP.store.getState()['features/base/config'].hideAddRoomButton)).toBe(true);
        expect(await (await host.driver.$('.breakout-room-container')).isExisting()).toBe(false);
    });

    it('shows no breakout-rooms button in the participants pane', async () => {
        // ADR 0007, checked where users would see it. The staff member is the moderator of the room.
        expect(await host.isModerator()).toBe(true);

        const pane = host.getParticipantsPane();

        await pane.open();
        expect(await host.driver.$('[aria-label="Add breakout room"]').isExisting()).toBe(false);
        expect(await host.driver.$('.breakout-room-container').isExisting()).toBe(false);
        await pane.close();
    });

    it('has deep linking off, so that a phone opens the link in its browser', async () => {
        expect(await host.execute(() => APP.store.getState()['features/base/config'].disableDeepLinking)).toBe(true);
    });
});
