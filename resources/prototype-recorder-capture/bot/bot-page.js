/* global JitsiMeetJS */
/*
 * PROTOTYPE - recorder bot, browser side. Runs in headless Chromium after
 * lib-jitsi-meet has loaded. Throwaway code: answers "can a hidden LJM client
 * record every remote track and show a recording label?". Not production code.
 *
 * Host bindings (exposed by run-bot.js):
 *   recbotTimeline(event)   append one event to timeline.json
 *   recbotChunk(file, b64)  append a base64 chunk to a recording file
 *   recbotDone(summary)     the bot has left; the runner may exit
 */
(function() {
    const P = window.RECBOT_PARAMS;
    const JIBRI_FEATURE = 'http://jitsi.org/protocol/jibri';

    let connection;
    let conference;
    let stopping = false;
    let emptyTimer = null;
    let fileSeq = 0;
    const recorders = new Map(); // track id -> recorder state

    function timeline(type, data = {}) {
        const ev = { t: new Date().toISOString(), type, ...data };

        console.log(`[recbot] ${type} ${JSON.stringify(data)}`);

        return window.recbotTimeline(ev);
    }

    function blobToBase64(blob) {
        return blob.arrayBuffer().then(buf => {
            const bytes = new Uint8Array(buf);
            let bin = '';

            for (let i = 0; i < bytes.length; i += 0x8000) {
                bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            }

            return btoa(bin);
        });
    }

    function humans() {
        return conference.getParticipants().filter(p => !p.isHidden());
    }

    // Stop rule (ADR 0003): leave once no human has been present for graceMs.
    function evaluatePresence() {
        if (stopping) {
            return;
        }
        const n = humans().length;

        if (n > 0) {
            if (emptyTimer) {
                clearTimeout(emptyTimer);
                emptyTimer = null;
                timeline('empty_timer_cancelled', { humans: n });
            }

            return;
        }
        if (!emptyTimer) {
            timeline('room_empty', { graceMs: P.graceMs });
            emptyTimer = setTimeout(() => stop('no_humans_for_grace'), P.graceMs);
        }
    }

    function applyReceiverConstraints(maxHeight) {
        conference.setReceiverConstraints({
            lastN: -1,
            defaultConstraints: { maxHeight },
            constraints: {}
        });
        timeline('receiver_constraints', { lastN: -1, maxHeight });
    }

    function startRecorder(track) {
        const kind = track.getType();
        const participantId = track.getParticipantId();
        const participant = conference.getParticipantById(participantId);
        const stream = new MediaStream([ track.getTrack() ]);
        const file = `${String(++fileSeq).padStart(2, '0')}-${participantId}-${kind}.webm`;
        const mimeType = kind === 'audio' ? 'audio/webm;codecs=opus' : 'video/webm;codecs=vp8';
        const state = { file, kind, participantId, chain: Promise.resolve(), bytes: 0, stopped: null };

        // Media elements keep the decoder running and let us observe the
        // received resolution. Audio element is muted: there is no output device.
        if (kind === 'audio' && P.attachAudio) {
            const el = document.createElement('audio');

            el.muted = true;
            el.autoplay = true;
            el.srcObject = stream;
            document.body.appendChild(el);
            el.play().catch(e => timeline('audio_play_failed', { file, error: String(e) }));
            state.el = el;
        }
        if (kind === 'video') {
            const el = document.createElement('video');

            el.muted = true;
            el.autoplay = true;
            el.playsInline = true;
            el.srcObject = stream;
            el.addEventListener('resize', () => {
                timeline('video_resolution', { file, width: el.videoWidth, height: el.videoHeight });
            });
            document.body.appendChild(el);
            el.play().catch(e => timeline('video_play_failed', { file, error: String(e) }));
            state.el = el;
        }

        const rec = new MediaRecorder(stream, {
            mimeType,
            audioBitsPerSecond: 64000,
            videoBitsPerSecond: 1500000
        });

        rec.ondataavailable = ev => {
            if (!ev.data || !ev.data.size) {
                return;
            }
            state.bytes += ev.data.size;

            // Keep chunk order: each write waits for the previous one.
            state.chain = state.chain
                .then(() => blobToBase64(ev.data))
                .then(b64 => window.recbotChunk(file, b64));
        };
        state.stopped = new Promise(resolve => {
            rec.onstop = () => resolve();
        });
        rec.onerror = e => timeline('recorder_error', { file, error: String(e.error || e) });
        rec.start(1000);
        state.rec = rec;
        recorders.set(track.getId(), state);

        timeline('track_recording_started', {
            file,
            kind,
            participantId,
            displayName: participant ? participant.getDisplayName() : undefined,
            sourceName: track.getSourceName ? track.getSourceName() : undefined,
            muted: track.isMuted(),
            mimeType
        });
    }

    async function stopRecorder(trackId, why) {
        const state = recorders.get(trackId);

        if (!state || state.closing) {
            return;
        }
        state.closing = true;
        if (state.rec.state !== 'inactive') {
            state.rec.stop();
        }
        await state.stopped;
        await state.chain;
        if (state.el) {
            state.el.srcObject = null;
            state.el.remove();
        }
        await timeline('track_recording_stopped', { file: state.file, why, bytes: state.bytes });
    }

    async function stop(reason) {
        if (stopping) {
            return;
        }
        stopping = true;
        clearTimeout(emptyTimer);
        await timeline('stopping', { reason });
        await Promise.all([ ...recorders.keys() ].map(id => stopRecorder(id, `bot_stopping:${reason}`)));
        try {
            await conference.leave();
        } catch (e) {
            // The room may already be destroyed.
        }
        try {
            connection.disconnect();
        } catch (e) {
            // Ignore.
        }
        await timeline('bot_left', { reason });
        window.recbotDone({ reason });
    }

    function participantInfo(id, user) {
        return {
            id,
            displayName: user.getDisplayName(),
            hidden: user.isHidden(),
            role: user.getRole(),
            humans: humans().length
        };
    }

    function joinConference() {
        const E = JitsiMeetJS.events.conference;

        conference = connection.initJitsiConference(P.room, {
            p2p: { enabled: false },
            openBridgeChannel: 'websocket'
        });

        // Path N2 (ADR 0004): session_id + mode in hidden-domain presence makes
        // every client create a FILE session with status "on".
        conference.room.addOrReplaceInPresence('session_id', { value: P.sessionId });
        conference.room.addOrReplaceInPresence('mode', { value: 'file' });

        conference.on(E.CONFERENCE_JOINED, () => {
            timeline('bot_joined', {
                room: P.room,
                myId: conference.myUserId(),
                meetingId: conference.getMeetingUniqueId(),
                isModerator: conference.isModerator(),
                sessionId: P.sessionId
            });
            applyReceiverConstraints(P.maxHeight);
            evaluatePresence();
            for (const step of P.constraintSchedule || []) {
                setTimeout(() => !stopping && applyReceiverConstraints(step.maxHeight), step.atMs);
            }
        });
        conference.on(E.USER_JOINED, (id, user) => {
            timeline('participant_joined', participantInfo(id, user));
            evaluatePresence();

            // A joiner gets occupant presences before its own join presence.
            // jitsi-meet only listens for recorder state from the first
            // presence it processes onwards, so if the bot's presence came
            // first the label is lost. Re-send it once the joiner listens.
            if (P.labelRebroadcastMs > 0) {
                setTimeout(() => {
                    if (!stopping) {
                        conference.room.sendPresence();
                        timeline('presence_rebroadcast', { forParticipant: id });
                    }
                }, P.labelRebroadcastMs);
            }
        });
        conference.on(E.USER_LEFT, (id, user) => {
            timeline('participant_left', participantInfo(id, user));
            evaluatePresence();
        });
        conference.on(E.USER_ROLE_CHANGED, (id, role) => {
            timeline('role_changed', { id, role, self: id === conference.myUserId() });
        });
        conference.on(E.TRACK_ADDED, track => {
            if (!track.isLocal()) {
                startRecorder(track);
            }
        });
        conference.on(E.TRACK_REMOVED, track => {
            if (!track.isLocal()) {
                stopRecorder(track.getId(), 'track_removed');
            }
        });
        conference.on(E.TRACK_MUTE_CHANGED, track => {
            const state = recorders.get(track.getId());

            timeline('track_mute_changed', {
                file: state && state.file,
                participantId: track.getParticipantId(),
                kind: track.getType(),
                muted: track.isMuted()
            });
        });
        conference.on(E.CONFERENCE_FAILED, (error, ...rest) => {
            timeline('conference_failed', { error, detail: rest.map(String) });
            stop(`conference_failed:${error}`);
        });
        conference.on(E.CONFERENCE_LEFT, () => {
            if (!stopping) {
                stop('conference_left');
            }
        });
        conference.on(E.KICKED, () => stop('kicked'));

        conference.join();
    }

    JitsiMeetJS.init({
        flags: { ssrcRewritingEnabled: false }
    });
    JitsiMeetJS.setLogLevel(JitsiMeetJS.logLevels.WARN);

    connection = new JitsiMeetJS.JitsiConnection(null, null, {
        hosts: { domain: P.domain, muc: P.muc },
        serviceUrl: `${P.websocketUrl}?room=${encodeURIComponent(P.room)}`
    });
    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_ESTABLISHED, () => {
        // Jicofo treats the bot as Jibri (feature + trusted domain), so it is
        // never elected moderator.
        connection.addFeature(JIBRI_FEATURE, true);
        timeline('connected', { jid: P.jid });
        joinConference();
    });
    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_FAILED, (err, msg) => {
        timeline('connection_failed', { err, msg: String(msg) });
        window.recbotDone({ reason: `connection_failed:${err}` });
    });
    connection.addEventListener(JitsiMeetJS.events.connection.CONNECTION_DISCONNECTED, () => {
        if (!stopping) {
            stop('connection_disconnected');
        }
    });
    connection.connect({ id: P.jid, password: P.password });
}());
