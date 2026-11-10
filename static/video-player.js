/* global JitsiMeetJS, config */

/**
 * The in-page half of the video player. The video player service (video-player/) loads static/video-player.html in
 * headless Chromium, exposes window.videoPlayerEvent() to receive what happens, then calls window.videoPlayer.start()
 * with the room, the token the coordinator service issued for it and the video's URL.
 *
 * This page joins the room as a visible participant with that token (which carries the video player's role marker),
 * publishes the video as its audio and video tracks, and reports when the video ends. The service tells the page to
 * leave with window.videoPlayer.stop().
 */
(function() {
    const LEAVE_TIMEOUT_MS = 3000;

    let connection;
    let conference;
    let element;
    let tracks = [];
    let stopping = false;

    /**
     * Reports an event to the video player service.
     *
     * @param {string} type - The event type.
     * @param {Object} data - Event data.
     * @returns {Promise<void>}
     */
    function emit(type, data = {}) {
        return window.videoPlayerEvent({ type,
            ...data });
    }

    /**
     * Names a room as Prosody and jitsi-meet do (getBackendSafeRoomName): NFKC, lower case, URL-encoded, lower case
     * again. The service passes the room as people know it, such as an HN, which may contain "/".
     *
     * @param {string} name - The room name.
     * @returns {string}
     */
    function backendSafeRoomName(name) {
        return encodeURIComponent(name.normalize('NFKC').toLowerCase()).replace(/\*/gu, '%2a')
            .toLowerCase();
    }

    /**
     * Returns the deployment's XMPP websocket URL for a room, with the token.
     *
     * @param {string} room - The backend-safe room name.
     * @param {string} token - The token.
     * @returns {string}
     */
    function websocketUrl(room, token) {
        const url = new URL(config.websocket || '../xmpp-websocket', window.location.href);

        if (url.protocol === 'http:' || url.protocol === 'https:') {
            url.protocol = url.protocol === 'http:' ? 'ws:' : 'wss:';
        }

        // Like jitsi-meet, name the room in the query as it is joined: some deployments route the websocket by it.
        url.searchParams.set('room', room);
        url.searchParams.set('token', token);

        return url.toString();
    }

    /**
     * Starts the video, and publishes its tracks into the conference once they exist.
     *
     * @param {string} videoUrl - The video file.
     * @returns {Promise<void>}
     */
    async function publishVideo(videoUrl) {
        element = document.createElement('video');
        element.crossOrigin = 'anonymous';
        element.playsInline = true;
        element.src = videoUrl;
        element.addEventListener('ended', () => {
            if (!stopping) {
                emit('ended');
            }
        });
        element.addEventListener('error', () => {
            if (!stopping) {
                emit('failed', { error: 'video_error' });
            }
        });
        document.body.appendChild(element);
        await element.play();

        const stream = element.captureStream();
        const infos = stream.getTracks().map(track => {
            return {
                mediaType: track.kind,
                sourceType: track.kind === 'video' ? 'camera' : 'microphone',
                stream: new MediaStream([ track ]),
                videoType: track.kind === 'video' ? 'camera' : undefined
            };
        });

        tracks = await JitsiMeetJS.createLocalTracksFromMediaStreams(infos);
        for (const track of tracks) {
            await conference.addTrack(track);
        }
    }

    /**
     * Joins the conference once connected.
     *
     * @param {Object} params - The room, token and video.
     * @returns {void}
     */
    function joinConference(params) {
        const events = JitsiMeetJS.events.conference;

        conference = connection.initJitsiConference(backendSafeRoomName(params.room), { p2p: { enabled: false } });
        conference.on(events.CONFERENCE_JOINED, () => {
            publishVideo(params.videoUrl).catch(error => {
                if (!stopping) {
                    emit('failed', { error: String(error?.name || error) });
                }
            });
        });
        conference.on(events.KICKED, () => emit('failed', { error: 'kicked' }));
        conference.on(events.CONFERENCE_FAILED, error => emit('failed', { error: String(error) }));
        conference.on(events.CONFERENCE_LEFT, () => {
            if (!stopping) {
                emit('failed', { error: 'conference_left' });
            }
        });
        conference.join();
    }

    window.videoPlayer = {
        /**
         * Connects with the room's token and joins the room.
         *
         * @param {Object} params - The parameters: room, token, videoUrl.
         * @returns {void}
         */
        start(params) {
            const events = JitsiMeetJS.events.connection;

            JitsiMeetJS.init({ flags: { ssrcRewritingEnabled: false } });

            // Library logs name the room, which is the patient's HN; keep them out of the service's logs.
            JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.ERROR);

            connection = new JitsiMeetJS.JitsiConnection(null, params.token, {
                hosts: {
                    domain: config.hosts.domain,
                    muc: config.hosts.muc
                },
                serviceUrl: websocketUrl(backendSafeRoomName(params.room), params.token)
            });
            connection.addEventListener(events.CONNECTION_ESTABLISHED, () => joinConference(params));
            connection.addEventListener(events.CONNECTION_FAILED, error => emit('failed', { error: String(error) }));
            connection.addEventListener(events.CONNECTION_DISCONNECTED, () => {
                if (!stopping) {
                    emit('failed', { error: 'connection_disconnected' });
                }
            });
            connection.connect();
        },

        /**
         * Stops the video, leaves the conference and disconnects.
         *
         * @returns {Promise<void>}
         */
        async stop() {
            stopping = true;
            element?.pause();
            await Promise.all(tracks.map(track => track.dispose().catch(() => undefined)));
            if (conference) {
                await Promise.race([
                    conference.leave().catch(() => undefined),
                    new Promise(resolve => setTimeout(resolve, LEAVE_TIMEOUT_MS))
                ]);
            }
            connection?.disconnect();
        }
    };
})();
