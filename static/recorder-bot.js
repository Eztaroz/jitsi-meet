/* global JitsiMeetJS, config */

/**
 * The in-page half of the recorder bot. The recorder bot service (recorder-bot/) loads static/recorder-bot.html in
 * headless Chromium, exposes window.recorderBotEvent() to receive what happens in the conference and
 * window.recorderBotChunk() to receive the recordings, then calls window.recorderBot.start() with the consultation's
 * parameters.
 *
 * This page joins, records each remote track, and reports. Audio is recorded with a MediaRecorder. Video is copied
 * without re-encoding: a WebRTC Encoded Transform on the track's receiver hands over the frames as the sender encoded
 * them (AV1, VP9 or VP8), and the page writes them as an IVF stream, which the service's ffmpeg stream copy turns into
 * WebM. A video track that cannot be copied is recorded with a MediaRecorder, and the page reports why as a recorder
 * error. The service decides when to stop (the consultation lifecycle module) and tells the page with
 * window.recorderBot.stop().
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

    // How often the bot tries again to join a room it may not start itself, as jitsi-meet does.
    const WAIT_FOR_HOST_RETRY_MS = 5000;

    // The codecs a video track is copied in, by the MIME type the encoded frames report, with their IVF fourcc.
    const IVF_FOURCC = {
        'video/av1': 'AV01',
        'video/vp8': 'VP80',
        'video/vp9': 'VP90'
    };

    // RTP timestamps of video run at 90 kHz.
    const RTP_VIDEO_CLOCK_HZ = 90000;

    // How often the bot asks the sender for a key frame while it has none, in milliseconds.
    const KEY_FRAME_REQUEST_MS = 1000;

    let connection;
    let conference;
    let stopping = false;
    let waitingForHost = false;
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
     * The worker that copies the encoded frames of every video receiver to the page, one port per receiver. It passes
     * each frame on unchanged, so the track still plays in the page, and asks the sender for a key frame until the page
     * has one.
     */
    let passthroughWorker;

    /**
     * Returns the worker that copies encoded frames, starting it on first use.
     *
     * @returns {Worker}
     */
    function getPassthroughWorker() {
        passthroughWorker ??= new Worker(URL.createObjectURL(new Blob([ `
onrtctransform = ({ transformer }) => {
    const { port } = transformer.options;
    let timer;

    function askForKeyFrame() {
        try {
            transformer.sendKeyFrameRequest().catch(() => undefined);
        } catch {
            // Without the request, the sender's next key frame will do.
        }
    }

    port.onmessage = () => clearInterval(timer);
    askForKeyFrame();
    timer = setInterval(askForKeyFrame, ${KEY_FRAME_REQUEST_MS});

    transformer.readable.pipeThrough(new TransformStream({
        transform(frame, controller) {
            const data = frame.data.slice(0);
            const { height, mimeType, rtpTimestamp, width } = frame.getMetadata();

            port.postMessage({ data, height, key: frame.type === 'key', mimeType, ts: rtpTimestamp ?? frame.timestamp,
                width }, [ data ]);
            controller.enqueue(frame);
        },
        flush() {
            clearInterval(timer);
        }
    })).pipeTo(transformer.writable);
};` ], { type: 'text/javascript' })));

        return passthroughWorker;
    }

    /**
     * Builds the 32-byte header of an IVF stream.
     *
     * @param {string} fourcc - The codec's fourcc.
     * @param {number} width - The first frame's width.
     * @param {number} height - The first frame's height.
     * @returns {ArrayBuffer}
     */
    function ivfFileHeader(fourcc, width, height) {
        const header = new DataView(new ArrayBuffer(32));

        [ ...'DKIF' ].forEach((c, i) => header.setUint8(i, c.charCodeAt(0)));
        header.setUint16(4, 0, true);
        header.setUint16(6, 32, true);
        [ ...fourcc ].forEach((c, i) => header.setUint8(8 + i, c.charCodeAt(0)));
        header.setUint16(12, width || 0, true);
        header.setUint16(14, height || 0, true);
        header.setUint32(16, RTP_VIDEO_CLOCK_HZ, true);
        header.setUint32(20, 1, true);

        return header.buffer;
    }

    /**
     * Builds the 12-byte header of one IVF frame.
     *
     * @param {number} size - The frame's size in bytes.
     * @param {number} pts - The frame's timestamp, in ticks of the 90 kHz clock.
     * @returns {ArrayBuffer}
     */
    function ivfFrameHeader(size, pts) {
        const header = new DataView(new ArrayBuffer(12));

        header.setUint32(0, size, true);
        header.setBigUint64(4, BigInt(pts), true);

        return header.buffer;
    }

    /**
     * Joins the frames of one picture, one per spatial layer, into one temporal unit. AV1 layers are consecutive
     * OBUs; VP9 layers are joined as a superframe, with its index.
     *
     * @param {string} mimeType - The codec's MIME type, lower case.
     * @param {ArrayBuffer[]} layers - The frames, lowest layer first.
     * @returns {Uint8Array[]} The temporal unit, as parts to be written one after the other.
     */
    function joinLayers(mimeType, layers) {
        const parts = layers.map(layer => new Uint8Array(layer));

        if (parts.length === 1 || mimeType !== 'video/vp9') {
            return parts;
        }

        const largest = Math.max(...parts.map(part => part.length));
        const sizeBytes = largest < 0x100 ? 1 : largest < 0x10000 ? 2 : largest < 0x1000000 ? 3 : 4;
        const marker = 0xc0 | (sizeBytes - 1) << 3 | parts.length - 1;
        const index = new Uint8Array(2 + parts.length * sizeBytes);

        index[0] = marker;
        index[index.length - 1] = marker;
        parts.forEach((part, i) => {
            for (let b = 0; b < sizeBytes; b++) {
                index[1 + i * sizeBytes + b] = part.length >>> 8 * b & 0xff;
            }
        });

        return [ ...parts, index ];
    }

    /**
     * Turns the encoded frames of one video track into an IVF stream.
     *
     * Frames before the first key frame are dropped. Timestamps are the RTP timestamp, unwrapped across its 32-bit wrap
     * and counted from the first key frame. Frames that share an RTP timestamp are the spatial layers of one picture,
     * and are written as one IVF frame. The track's resolution may change; the stream stays one stream.
     *
     * @param {Function} write - Called with each piece of the stream, as an ArrayBuffer or typed array.
     * @returns {Object} The writer: `push(frame)` takes a frame as the transform's worker sent it, `end()` writes the
     * last picture.
     */
    function createIvfWriter(write) {
        let started = false;
        let layers = [];
        let layersMimeType;
        let layersTs;
        let pts = 0;
        let lastTs;

        const writePicture = () => {
            if (!layers.length) {
                return;
            }

            // RTP timestamps are 32 bits and wrap; step by the signed difference.
            pts += Math.max(0, layersTs - lastTs | 0);
            lastTs = layersTs;

            const parts = joinLayers(layersMimeType, layers);

            write(ivfFrameHeader(parts.reduce((sum, part) => sum + part.length, 0), pts));
            parts.forEach(write);
            layers = [];
        };

        return {
            push({ data, height, key, mimeType, ts, width }) {
                if (!started) {
                    if (!key) {
                        return;
                    }
                    started = true;
                    lastTs = ts;
                    write(ivfFileHeader(IVF_FOURCC[mimeType], width, height));
                }
                if (layers.length && (ts - layersTs | 0) !== 0) {
                    // A frame older than the picture being joined arrived late; it cannot go back in the file.
                    if ((ts - layersTs | 0) < 0) {
                        return;
                    }
                    writePicture();
                }
                layersTs = ts;
                layersMimeType = mimeType;
                layers.push(data);
            },
            end: writePicture
        };
    }

    /**
     * Starts recording a video track by copying its encoded frames into an IVF stream, without re-encoding.
     *
     * @param {JitsiRemoteTrack} track - The track.
     * @param {Function} deliver - Delivers a chunk, as a Blob.
     * @param {Function} giveUp - Called with a reason when the track cannot be copied. Nothing has been delivered.
     * @returns {Object|undefined} An object shaped like the MediaRecorder the rest of the page expects, or undefined
     * when the track cannot be copied; `giveUp` has been called then.
     */
    function startPassthrough(track, deliver, giveUp) {
        if (typeof RTCRtpScriptTransform === 'undefined') {
            giveUp('passthrough_unsupported');

            return undefined;
        }

        const pc = conference.jvbJingleSession?.peerconnection?.peerconnection;
        const receiver = pc?.getReceivers().find(r => r.track === track.getTrack());

        if (!receiver) {
            giveUp('passthrough_receiver_not_found');

            return undefined;
        }

        const channel = new MessageChannel();
        let parts = [];
        let gotKeyFrame = false;
        let settled = false;

        const writer = createIvfWriter(part => parts.push(part));
        const flush = () => {
            if (parts.length) {
                deliver(new Blob(parts));
                parts = [];
            }
        };
        const detach = () => {
            clearInterval(timer);
            try {
                receiver.transform = null;
            } catch {
                // The receiver may be gone with the track.
            }
            channel.port1.close();
        };

        channel.port1.onmessage = ({ data: frame }) => {
            if (settled) {
                return;
            }
            if (!IVF_FOURCC[frame.mimeType?.toLowerCase()]) {
                // Which codec the sender used is known from its first frame.
                settled = true;
                detach();
                recorder.state = 'inactive';
                giveUp(`passthrough_codec_${frame.mimeType}`);

                return;
            }
            frame.mimeType = frame.mimeType.toLowerCase();
            writer.push(frame);
            if (frame.key && !gotKeyFrame) {
                gotKeyFrame = true;

                // The worker stops asking for key frames.
                channel.port1.postMessage('got_key_frame');
            }
        };

        const timer = setInterval(flush, CHUNK_MS);

        receiver.transform = new RTCRtpScriptTransform(getPassthroughWorker(), { port: channel.port2 },
            [ channel.port2 ]);

        const recorder = {
            state: 'recording',
            stop() {
                if (recorder.state === 'inactive') {
                    return;
                }
                recorder.state = 'inactive';
                detach();
                writer.end();
                flush();
                recorder.onstop?.();
            }
        };

        return recorder;
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

        // Chunks are delivered one after the other, after the service has named the track's file.
        let chain = emit('track_started', {
            endpointId: track.getParticipantId(),
            kind,
            recorderId
        });
        const deliver = data => {
            chain = chain
                .then(() => toBase64(data))
                .then(base64 => window.recorderBotChunk(recorderId, base64))
                .catch(error => emit('recorder_error', {
                    error: String(error?.name || error),
                    recorderId
                }));
        };
        const reportError = error => {
            chain = chain.then(() => emit('recorder_error', {
                error,
                recorderId
            }));
        };

        // What the rest of the page stops: the track's MediaRecorder, or the copy of its frames until that gives up and
        // a MediaRecorder takes over.
        let finished;
        const handle = {
            state: 'recording',
            stop() {
                handle.state = 'inactive';
                handle.inner?.stop();
            }
        };

        // The last chunk comes just before the recorder stops; it is delivered once the chain has caught up.
        const done = new Promise(resolve => {
            finished = resolve;
        }).then(() => chain);

        const startMediaRecorder = () => {
            const recorder = new MediaRecorder(stream,
                kind === 'audio' ? AUDIO_RECORDER_OPTIONS : VIDEO_RECORDER_OPTIONS);

            recorder.ondataavailable = ({ data }) => {
                if (data.size) {
                    deliver(data);
                }
            };
            recorder.onerror = event => reportError(String(event.error?.name || event.error));
            recorder.onstop = finished;
            handle.inner = recorder;
            recorder.start(CHUNK_MS);
        };

        delivered.add(done);
        recorders.set(track, {
            element,
            recorder: handle,
            recorderId
        });

        if (kind === 'video') {
            // A track that cannot be copied is recorded with a MediaRecorder, and the service logs why.
            const copy = startPassthrough(track, deliver, reason => {
                reportError(reason);
                if (handle.state === 'recording') {
                    startMediaRecorder();
                }
            });

            if (copy) {
                copy.onstop = finished;
                handle.inner = copy;
            }
        } else {
            startMediaRecorder();
        }
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
            hidden: user.isHidden(),

            // With JWT authentication, Prosody puts the token's user and group claims here, and the service decides
            // what to trust.
            identity: user.getIdentity()
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
            // The bot's own account is on the hidden domain. lib-jitsi-meet needs it to tell other participants on
            // it, such as another recorder, or this bot's previous session after a crash, from humans.
            hiddenDomain: params.jid.slice(params.jid.indexOf('@') + 1),
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
            } else if (error === JitsiMeetJS.errors.conference.AUTHENTICATION_REQUIRED) {
                // With Jicofo authentication, only an authenticated participant starts the room. Wait for one; the
                // service's first-join wait still applies.
                if (!waitingForHost) {
                    waitingForHost = true;
                    emit('waiting_for_host');
                }
                setTimeout(() => {
                    if (!stopping) {
                        conference.join();
                    }
                }, WAIT_FOR_HOST_RETRY_MS);
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
