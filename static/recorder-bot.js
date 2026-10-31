/* global JitsiMeetJS, config */

/**
 * The in-page half of the recorder bot. The recorder bot service (recorder-bot/) loads static/recorder-bot.html in
 * headless Chromium, exposes window.recorderBotEvent() to receive what happens in the conference and
 * window.recorderBotChunk() to receive the recordings, then calls window.recorderBot.start() with the consultation's
 * parameters.
 *
 * This page joins, records each remote track with its own MediaRecorder, and reports. The service decides when to
 * stop (the consultation lifecycle module) and tells the page with window.recorderBot.stop().
 */
(function() {
    const JIBRI_FEATURE = 'http://jitsi.org/protocol/jibri';
    const LEAVE_TIMEOUT_MS = 3000;

    // Each recorder hands over a chunk every second, so a crash loses at most about a second of each track.
    const CHUNK_MS = 1000;
    const AUDIO_RECORDER_OPTIONS = { audioBitsPerSecond: 64000,
        mimeType: 'audio/webm;codecs=opus' };
    const VIDEO_RECORDER_OPTIONS = { mimeType: 'video/webm;codecs=vp8',
        videoBitsPerSecond: 1500000 };

    // How long after a participant joins the bot sends its presence again (ADR 0004).
    const PRESENCE_RESEND_MS = 2000;

    let connection;
    let conference;
    let stopping = false;
    let recorderCount = 0;

    /** The recorder of each remote track that is being recorded. */
    const recorders = new Map();

    /** Every recorder's promise that its last chunk has been delivered. */
    const delivered = new Set();

    /**
     * Reports an event to the recorder bot service.
     *
     * @param {string} type - The event type.
     * @param {Object} data - Event data.
     * @returns {Promise<void>} Settles once the service has handled the event.
     */
    function emit(type, data = {}) {
        return window.recorderBotEvent({ type,
            ...data });
    }

    /**
     * Reads a blob as base64, the form in which a chunk crosses over to the service.
     *
     * @param {Blob} blob - The blob.
     * @returns {Promise<string>}
     */
    function toBase64(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();

            reader.onload = () => resolve(reader.result.slice(reader.result.indexOf(',') + 1));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(blob);
        });
    }

    /**
     * Starts recording a remote track.
     *
     * @param {JitsiRemoteTrack} track - The track.
     * @returns {void}
     */
    function startRecording(track) {
        const kind = track.getType();
        const recorderId = `r${++recorderCount}`;
        const stream = new MediaStream([ track.getTrack() ]);

        // Chromium delivers no remote audio to a recorder unless the track also plays in a media element; muted,
        // since there is nothing to play it on. A video element reports the resolution the video arrives at.
        const element = document.createElement(kind);

        element.muted = true;
        element.autoplay = true;
        element.srcObject = stream;
        if (kind === 'video') {
            let size;

            element.playsInline = true;
            element.addEventListener('resize', () => {
                const { videoHeight: height, videoWidth: width } = element;

                if (size !== `${width}x${height}`) {
                    size = `${width}x${height}`;
                    emit('video_resolution', {
                        height,
                        recorderId,
                        width
                    });
                }
            });
        }
        document.body.appendChild(element);
        element.play().catch(() => undefined);

        const recorder = new MediaRecorder(stream, kind === 'audio' ? AUDIO_RECORDER_OPTIONS : VIDEO_RECORDER_OPTIONS);

        // Chunks are delivered one after the other, after the service has named the track's file.
        let chain = emit('track_started', {
            endpointId: track.getParticipantId(),
            kind,
            recorderId
        });

        recorder.ondataavailable = ({ data }) => {
            if (data.size) {
                chain = chain
                    .then(() => toBase64(data))
                    .then(base64 => window.recorderBotChunk(recorderId, base64))
                    .catch(error => emit('recorder_error', {
                        error: String(error),
                        recorderId
                    }));
            }
        };
        recorder.onerror = event => emit('recorder_error', {
            error: String(event.error?.name || event.error),
            recorderId
        });

        // The last chunk comes just before the recorder stops; it is delivered once the chain has caught up.
        const done = new Promise(resolve => {
            recorder.onstop = resolve;
        }).then(() => chain);

        delivered.add(done);
        recorder.start(CHUNK_MS);
        recorders.set(track, {
            element,
            recorder,
            recorderId
        });
    }

    /**
     * Stops recording a track.
     *
     * @param {JitsiRemoteTrack} track - The track.
     * @returns {Object|undefined} The track's recorder, if it was recorded.
     */
    function stopRecording(track) {
        const state = recorders.get(track);

        if (!state) {
            return undefined;
        }
        recorders.delete(track);
        if (state.recorder.state !== 'inactive') {
            state.recorder.stop();
        }
        state.element.srcObject = null;
        state.element.remove();

        return state;
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

        // The meeting id usually arrives just after the join.
        conference.on(events.CONFERENCE_UNIQUE_ID_SET, () => {
            emit('meeting_id', { meetingId: conference.getMeetingUniqueId() });
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
        conference.on(events.TRACK_ADDED, track => {
            if (!track.isLocal() && !stopping) {
                startRecording(track);
            }
        });
        conference.on(events.TRACK_REMOVED, track => {
            const state = stopRecording(track);

            if (state && !stopping) {
                emit('track_stopped', { recorderId: state.recorderId });
            }
        });
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
         * Closes every recorder and delivers its last chunks, then leaves the conference and disconnects.
         *
         * @param {Object} options - Options.
         * @param {boolean} options.leave - Whether to leave the conference first. Not worth waiting for when the
         * room was destroyed.
         * @returns {Promise<void>}
         */
        async stop({ leave }) {
            stopping = true;
            for (const track of [ ...recorders.keys() ]) {
                stopRecording(track);
            }
            await Promise.all(delivered);
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
