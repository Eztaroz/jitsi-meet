'use strict';

/*
 * The coordinator screen. It shows the queues and the open rooms, and refreshes every few seconds. Everything it shows
 * is put in the page as text, never as markup: names come from the participants' tokens.
 */
(function () {
    var TOKEN_KEY = 'coordinator-token';
    var REFRESH_MS = 3000;
    var STAGES = [
        [ 'waiting', 'รอคิว' ],
        [ 'intake', 'ให้ข้อมูลก่อนพบแพทย์' ],
        [ 'examination', 'พบแพทย์' ],
        [ 'aftercare', 'หลังพบแพทย์' ]
    ];
    var STAGE_NAMES = { aftercare: 'หลังพบแพทย์', intake: 'ให้ข้อมูลก่อนพบแพทย์' };
    var ROLES = { hidden: 'ระบบบันทึก', patient: 'ผู้ป่วย', staff: 'เจ้าหน้าที่', unknown: 'ไม่ทราบตัวตน' };
    var ERRORS = {
        bad_signature: 'โทเคนนี้ไม่ได้ออกโดยระบบของโรงพยาบาล',
        expired: 'โทเคนหมดอายุแล้ว',
        malformed: 'โทเคนไม่ถูกต้อง',
        no_identity: 'โทเคนนี้ไม่ระบุตัวผู้ใช้',
        not_a_coordinator: 'บัญชีนี้ไม่ได้เป็นผู้ประสานงาน',
        not_yet_valid: 'โทเคนยังใช้ไม่ได้',
        unknown_key: 'ไม่รู้จักกุญแจของโทเคนนี้',
        unsupported_algorithm: 'โทเคนไม่ถูกต้อง',
        wrong_audience: 'โทเคนนี้ไม่ใช่สำหรับระบบนี้',
        wrong_issuer: 'โทเคนนี้ไม่ได้ออกโดยระบบของโรงพยาบาล'
    };
    var REASONS = {
        already_being_moved: 'กำลังย้ายผู้นี้อยู่แล้ว',
        could_not_send_move: 'ส่งคำสั่งย้ายไม่ได้',
        destination_holds_a_patient: 'ห้องปลายทางมีผู้ป่วยอยู่แล้ว',
        destination_not_open: 'ห้องปลายทางยังไม่เปิด',
        participant_did_not_arrive: 'ผู้ถูกย้ายไม่ไปถึงห้องปลายทาง',
        participant_not_found: 'ไม่พบผู้ที่จะย้ายในห้อง',
        participant_not_movable: 'ย้ายผู้นี้ไม่ได้',
        patient_into_lounge: 'ห้ามย้ายผู้ป่วยเข้าห้องพักเจ้าหน้าที่',
        patient_room_unknown: 'ไม่ทราบห้องของผู้ป่วยรายนี้',
        recorder_bot_at_capacity: 'ระบบบันทึกเต็ม ย้ายไม่ได้',
        recorder_bot_not_ready: 'ระบบบันทึกไม่พร้อมภายใน 30 วินาที',
        recorder_bot_unreachable: 'ติดต่อระบบบันทึกไม่ได้'
    };
    var OUTCOMES = { cancelled: 'ผู้ถูกย้ายกดยกเลิก', done: 'ย้ายสำเร็จ', failed: 'ย้ายไม่สำเร็จ', refused: 'ไม่อนุญาตให้ย้าย' };
    var ALL_STAGES = STAGES.concat([ [ 'done', 'เสร็จสิ้น' ] ]);

    /** What the coordinator has chosen in the lists, kept across the redraws. */
    var choices = {};

    /** The name of everyone seen, by endpoint, so that a move can be described after the person has gone. */
    var names = {};
    var latest;
    var timer;

    /**
     * Finds an element.
     *
     * @param {string} id - Its id.
     * @returns {HTMLElement}
     */
    function $(id) {
        return document.getElementById(id);
    }

    /**
     * Calls an acting route of the screen's API.
     *
     * @param {string} path - The route.
     * @param {Object} body - What to send.
     * @returns {Promise<Object>} The status and the body.
     */
    function act(path, body) {
        return fetch('/screen/api' + path, {
            body: JSON.stringify(body),
            headers: { Authorization: 'Bearer ' + sessionStorage.getItem(TOKEN_KEY), 'Content-Type': 'application/json' },
            method: 'POST'
        }).then(function (response) {
            return response.json().catch(function () {
                return {};
            }).then(function (json) {
                return { body: json, status: response.status };
            });
        });
    }

    /**
     * Tells the coordinator what came of a request, until the next one.
     *
     * @param {string} text - What.
     * @returns {void}
     */
    function say(text) {
        $('notice').hidden = !text;
        $('notice').textContent = text || '';
    }

    /**
     * Makes an element with text.
     *
     * @param {string} tag - The tag.
     * @param {string} text - The text.
     * @param {string} className - The class.
     * @returns {HTMLElement}
     */
    function el(tag, text, className) {
        var node = document.createElement(tag);

        if (text !== undefined) {
            node.textContent = text;
        }
        if (className) {
            node.className = className;
        }

        return node;
    }

    /**
     * Formats a waiting time.
     *
     * @param {number} seconds - How long.
     * @returns {string}
     */
    function waited(seconds) {
        if (seconds < 60) {
            return seconds + ' วินาที';
        }

        return Math.floor(seconds / 60) + ' นาที ' + (seconds % 60) + ' วินาที';
    }

    /**
     * Shows the sign-in form, with a reason if there is one.
     *
     * @param {string} message - Why, or nothing.
     * @returns {void}
     */
    function showSignIn(message) {
        clearTimeout(timer);
        sessionStorage.removeItem(TOKEN_KEY);
        $('signin').hidden = false;
        $('board').hidden = true;
        $('who').hidden = true;
        $('signin-error').hidden = !message;
        $('signin-error').textContent = message || '';
    }

    /**
     * Draws the queues.
     *
     * @param {Object} queues - The queues by stage.
     * @returns {void}
     */
    function drawQueues(queues) {
        var list = $('queue-list');

        list.textContent = '';
        list.className = 'grid';
        STAGES.forEach(function (stage) {
            var card = el('div', undefined, 'card');
            var entries = queues[stage[0]] || [];

            card.id = 'queue-' + stage[0];
            var title = el('h3', stage[1]);

            title.appendChild(el('span', String(entries.length), 'badge'));
            card.appendChild(title);
            if (!entries.length) {
                card.appendChild(el('div', 'ไม่มีผู้ป่วยรอ', 'empty'));
            }
            entries.forEach(function (entry) {
                var row = el('div', undefined, 'queue-entry' + (entry.suggested ? ' suggested' : ''));

                row.dataset.encounter = entry.encounterId;
                row.appendChild(el('span', entry.hn || ''));
                row.appendChild(el('span', waited(entry.waitedSeconds) + (entry.suggested ? ' · แนะนำคนถัดไป' : '')));

                var key = 'stage|' + entry.encounterId;
                var pick = el('select', undefined, 'stage-to');

                ALL_STAGES.forEach(function (stage) {
                    var option = el('option', stage[1]);

                    option.value = stage[0];
                    pick.appendChild(option);
                });
                pick.value = choices[key] || stage[0];
                pick.addEventListener('change', function () {
                    choices[key] = pick.value;
                });

                var go = el('button', 'เปลี่ยนขั้น', 'stage-go');

                go.type = 'button';
                go.addEventListener('click', function () {
                    changeStage(entry.encounterId, pick.value);
                });

                var done = el('button', 'เสร็จสิ้น', 'stage-done secondary');

                done.type = 'button';
                done.addEventListener('click', function () {
                    changeStage(entry.encounterId, 'done');
                });

                var controls = el('div', undefined, 'controls');

                controls.appendChild(pick);
                controls.appendChild(go);
                controls.appendChild(done);
                card.appendChild(row);
                card.appendChild(controls);
            });
            list.appendChild(card);
        });
    }

    /**
     * Describes a room's kind.
     *
     * @param {Object} room - The room.
     * @returns {string}
     */
    function kindName(room) {
        if (room.kind === 'lounge') {
            return 'ห้องพักเจ้าหน้าที่';
        }
        if (room.kind === 'station') {
            return 'จุดบริการ: ' + (STAGE_NAMES[room.stage] || '');
        }

        return 'ห้องผู้ป่วย';
    }

    /**
     * Asks to move someone.
     *
     * @param {string} room - Where they are.
     * @param {string} endpointId - Which of the room's occupants.
     * @param {string} destination - The room to send them to.
     * @returns {void}
     */
    function move(room, endpointId, destination) {
        if (!destination) {
            return;
        }
        act('/moves', { from: { endpointId: endpointId, room: room }, to: { room: destination } }).then(function (result) {
            if (result.status >= 400) {
                say(result.status === 503 ? 'ติดต่อระบบไม่ได้ ย้ายไม่สำเร็จ' : 'ย้ายไม่สำเร็จ');
            } else if (result.body.state === 'refused') {
                say(OUTCOMES.refused + ': ' + (REASONS[result.body.reason] || result.body.reason));
            } else {
                say('');
            }
            refresh();
        });
    }

    /**
     * Puts an encounter in a stage.
     *
     * @param {string} encounterId - The encounter.
     * @param {string} stage - The stage.
     * @returns {void}
     */
    function changeStage(encounterId, stage) {
        act('/encounters/' + encodeURIComponent(encounterId) + '/stage', { stage: stage }).then(function (result) {
            say(result.status === 409 ? 'encounter นี้เสร็จสิ้นแล้ว' : result.status >= 400 ? 'เปลี่ยนขั้นไม่สำเร็จ' : '');
            refresh();
        });
    }

    /**
     * Draws the rooms and who is in them.
     *
     * @param {Object[]} rooms - The rooms.
     * @param {Object[]} moves - The moves under way and recent.
     * @returns {void}
     */
    function drawRooms(rooms, moves) {
        var list = $('rooms');

        list.textContent = '';
        list.className = 'grid';
        rooms.forEach(function (room) {
            var card = el('div', undefined, 'card room');
            var title = el('h3', room.name);

            card.dataset.room = room.name;
            card.dataset.kind = room.kind;
            title.appendChild(el('span', kindName(room), 'badge'));
            if (!room.open) {
                title.appendChild(el('span', 'ปิดอยู่', 'badge'));
            }
            if (room.kind === 'patient' && room.open && !room.encounterId) {
                title.appendChild(el('span', 'ยังไม่มี encounter', 'badge warn'));
            }
            card.appendChild(title);
            if (room.kind === 'patient' && room.open && !room.encounterId) {
                var start = el('button', 'เริ่ม encounter', 'start-encounter');

                start.type = 'button';
                start.addEventListener('click', function () {
                    act('/encounters', { hn: room.name }).then(function (result) {
                        say(result.status >= 400 ? 'เริ่ม encounter ไม่สำเร็จ (ระบบบันทึกอาจเต็ม)' : '');
                        refresh();
                    });
                });
                card.appendChild(start);
            }
            room.occupants.forEach(function (o) {
                var who = o.identity && o.identity.name || o.displayName || 'ไม่ระบุชื่อ';
                var line = el('div', undefined, 'occupant');
                var moving = moves.some(function (m) {
                    return (m.state === 'counting_down' || m.state === 'preparing') && m.origin === room.name && m.endpointId === o.endpointId;
                });

                names[o.endpointId] = who;
                line.dataset.role = o.role;
                line.dataset.endpoint = o.endpointId;
                line.appendChild(el('span', who + ' · ' + ROLES[o.role]));
                if (moving) {
                    line.appendChild(el('span', 'กำลังย้าย', 'badge moving'));
                } else if (o.role === 'patient' || o.role === 'staff') {
                    var key = 'move|' + room.name + '|' + o.endpointId;
                    var pick = el('select', undefined, 'move-to');
                    var blank = el('option', 'ย้ายไปห้อง…');

                    blank.value = '';
                    pick.appendChild(blank);
                    rooms.forEach(function (other) {
                        if (other.name !== room.name) {
                            var option = el('option', other.name + (other.open ? '' : ' (ปิดอยู่)'));

                            option.value = other.name;
                            pick.appendChild(option);
                        }
                    });
                    pick.value = choices[key] || '';
                    pick.addEventListener('change', function () {
                        choices[key] = pick.value;
                    });

                    var go = el('button', 'ย้าย', 'move-go');

                    go.type = 'button';
                    go.addEventListener('click', function () {
                        var to = pick.value;

                        delete choices[key];
                        move(room.name, o.endpointId, to);
                    });
                    line.appendChild(pick);
                    line.appendChild(go);
                }
                card.appendChild(line);
            });
            if (!room.occupants.length) {
                card.appendChild(el('div', 'ไม่มีใครอยู่', 'empty'));
            }
            list.appendChild(card);
        });
    }

    /**
     * Draws what came of the moves, so that a cancellation or a failure is seen.
     *
     * @param {Object[]} moves - The moves under way and recent.
     * @returns {void}
     */
    function drawOutcomes(moves) {
        var list = $('outcomes');

        list.textContent = '';
        moves.filter(function (m) {
            return OUTCOMES[m.state];
        }).sort(function (a, b) {
            return new Date(b.startedAt) - new Date(a.startedAt);
        }).forEach(function (m) {
            var text = (names[m.endpointId] || 'ผู้เข้าร่วม') + ': ' + OUTCOMES[m.state]
                + (m.reason ? ' (' + (REASONS[m.reason] || m.reason) + ')' : '');
            var item = el('li', text, 'outcome ' + m.state);

            item.dataset.move = m.id;
            list.appendChild(item);
        });
    }

    /**
     * Reads the state from the service and draws it.
     *
     * @returns {void}
     */
    function refresh() {
        var token = sessionStorage.getItem(TOKEN_KEY);

        if (!token) {
            showSignIn();

            return;
        }
        fetch('/screen/api/state', { headers: { Authorization: 'Bearer ' + token } })
            .then(function (response) {
                if (response.status === 401 || response.status === 403) {
                    return response.json().then(function (body) {
                        showSignIn(ERRORS[body.error] || 'เข้าสู่ระบบไม่ได้');
                    });
                }
                if (!response.ok) {
                    throw new Error('state');
                }

                return response.json().then(function (state) {
                    $('signin').hidden = true;
                    $('board').hidden = false;
                    $('who').hidden = false;
                    $('who-name').textContent = state.coordinator.name || state.coordinator.id;
                    $('problem').hidden = true;
                    latest = state;
                    // A list that is being chosen from would close if it were drawn again.
                    if (!document.activeElement || document.activeElement.tagName !== 'SELECT') {
                        drawQueues(state.queues);
                        drawRooms(state.rooms, state.moves);
                    }
                    drawOutcomes(state.moves);
                });
            })
            .catch(function () {
                $('problem').hidden = false;
                $('problem').textContent = 'ติดต่อระบบไม่ได้ กำลังลองใหม่';
            })
            .then(function () {
                clearTimeout(timer);
                if (sessionStorage.getItem(TOKEN_KEY)) {
                    timer = setTimeout(refresh, REFRESH_MS);
                }
            });
    }

    $('signin-form').addEventListener('submit', function (event) {
        event.preventDefault();
        sessionStorage.setItem(TOKEN_KEY, $('signin-token').value.trim());
        $('signin-token').value = '';
        refresh();
    });
    $('sign-out').addEventListener('click', function () {
        showSignIn();
    });

    // A single sign-on can send the coordinator here with the token in the address's fragment, which a server never sees.
    var fromFragment = /[#&]jwt=([^&]+)/.exec(location.hash);

    if (fromFragment) {
        sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(fromFragment[1]));
        history.replaceState(null, '', location.pathname);
    }
    refresh();
}());
