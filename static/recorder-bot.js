/* global JitsiMeetJS, config */

/**
 * The in-page half of the recorder bot. The recorder bot service (recorder-bot/) loads static/recorder-bot.html in
 * headless Chromium, exposes window.recorderBotEvent() to receive what happens in the conference, then calls
 * window.recorderBot.start() with the consultation's parameters.
 *
 * This page only joins and reports. The service decides when to stop (the consultation lifecycle module) and tells
 * the page with window.recorderBot.stop().
 */
(function() {
    const JIBRI_FEATURE = 'http://jitsi.org/protocol/jibri';
    const LEAVE_TIMEOUT_MS = 3000;

    // How long after a participant joins the bot sends its presence again (ADR 0004).
    const PRESENCE_RESEND_MS = 2000;

    let connection;
    let conference;
    let stopping = false;

    /**
     * Reports an event to the recorder bot service.
     *
     * @param {string} type - The event type.
     * @param {Object} data - Event data.
     * @returns {void}
     */
    function emit(type, data = {}) {
        window.recorderBotEvent({ type,
            ...data });
    }

    /**
     * Returns the deployment's XMPP websocket URL for a room. Falls back to the websocket on this page's origin when
     * the deployment's config.js does not name one.
     *
     * @param {string} room - The backend-safe room name.
     * @returns {string}
     */
    function websocketUrl(room) {
        const url = new URL(config.websocket || '../xmpp-websocket', window.location.href);

        if (url.protocol === 'http:' || url.protocol === 'https:') {
            url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        }

        // Like jitsi-meet, name the room in the query as it is joined: some deployments route the websocket by it.
        url.searchParams.set('room', room);

        return url.toString();
    }

    /**
     * Describes a participant for the service.
     *
     * @param {string} endpointId - The participant's endpoint id.
     * @param {JitsiParticipant} user - The participant.
     * @returns {Object}
     */
    function participant(endpointId, user) {
        return {
            displayName: user.getDisplayName(),
            endpointId,
            hidden: user.isHidden()
        };
    }

    /**
     * Joins the conference once connected.
     *
     * @param {Object} params - The consultation's parameters.
     * @returns {void}
     */
    function joinConference(params) {
        const events = JitsiMeetJS.events.conference;

        conference = connection.initJitsiConference(params.room, {
            p2p: { enabled: false }
        });

        // ADR 0004: a file recording session in the hidden bot's presence makes every participant's jitsi-meet show
        // its recording label. The session is the consultation.
        conference.room.addOrReplaceInPresence('session_id', { value: params.consultationId });
        conference.room.addOrReplaceInPresence('mode', { value: 'file' });

        conference.on(events.CONFERENCE_JOINED, () => {
            conference.setReceiverConstraints({
                constraints: {},
                defaultConstraints: { maxHeight: params.maxHeight },
                lastN: -1
            });
            emit('joined', { meetingId: conference.getMeetingUniqueId() });
        });
        conference.on(events.USER_JOINED, (id, user) => {
            emit('participant_joined', participant(id, user));

            // A joiner receives the bot's presence before its own join completes, which can be before jitsi-meet
            // listens for recording sessions; that joiner would never show the label. Send it again once it listens.
            setTimeout(() => {
                if (!stopping) {
                    conference.room.sendPresence();
                }
            }, PRESENCE_RESEND_MS);
        });
        conference.on(events.USER_LEFT, id => emit('participant_left', { endpointId: id }));
        conference.on(events.KICKED, () => emit('kicked'));
        conference.on(events.CONFERENCE_FAILED, error => {
            if (error === JitsiMeetJS.errors.conference.CONFERENCE_DESTROYED) {
                emit('room_destroyed');
            } else {
                emit('conference_failed', { error });
            }
        });
        conference.on(events.CONFERENCE_LEFT, () => {
            if (!stopping) {
                emit('disconnected', { error: 'conference_left' });
            }
        });

        conference.join();
    }

    window.recorderBot = {
        /**
         * Connects as the bot account and joins the room.
         *
         * @param {Object} params - The consultation's parameters: consultationId, room, jid, password, maxHeight.
         * @returns {void}
         */
        start(params) {
            const events = JitsiMeetJS.events.connection;

            // SSRC rewriting is not advertised: the bot records each participant's own track.
            JitsiMeetJS.init({ flags: { ssrcRewritingEnabled: false } });

            // Library logs name the room, which is the patient's HN; keep them out of the service's logs.
            JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.ERROR);

            connection = new JitsiMeetJS.JitsiConnection(null, null, {
                hosts: {
                    domain: config.hosts.domain,
                    focus: config.hosts.focus,
                    muc: config.hosts.muc
                },
                serviceUrl: websocketUrl(params.room)
            });
            connection.addEventListener(events.CONNECTION_ESTABLISHED, () => {
                // With the recorder domain in Jicofo's trusted-domains, this feature makes Jicofo treat the bot as
                // Jibri, so it is never elected moderator.
                connection.addFeature(JIBRI_FEATURE, true);
                emit('connected');
                joinConference(params);
            });
            connection.addEventListener(events.CONNECTION_FAILED, error => emit('connection_failed', { error }));
            connection.addEventListener(events.CONNECTION_DISCONNECTED, () => {
                if (!stopping) {
                    emit('disconnected', { error: 'connection_disconnected' });
                }
            });
            connection.connect({
                id: params.jid,
                password: params.password
            });
        },

        /**
         * Leaves the conference and disconnects.
         *
         * @param {Object} options - Options.
         * @param {boolean} options.leave - Whether to leave the conference first. Not worth waiting for when the
         * room was destroyed.
         * @returns {Promise<void>}
         */
        async stop({ leave }) {
            stopping = true;
            if (leave && conference) {
                await Promise.race([
                    conference.leave().catch(() => undefined),
                    new Promise(resolve => setTimeout(resolve, LEAVE_TIMEOUT_MS))
                ]);
            }
            connection?.disconnect();
        }
    };
})();
