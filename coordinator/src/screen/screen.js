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

                row.appendChild(el('span', entry.hn || ''));
                row.appendChild(el('span', waited(entry.waitedSeconds) + (entry.suggested ? ' · แนะนำคนถัดไป' : '')));
                card.appendChild(row);
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
     * Draws the rooms and who is in them.
     *
     * @param {Object[]} rooms - The rooms.
     * @returns {void}
     */
    function drawRooms(rooms) {
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
            room.occupants.forEach(function (o) {
                var line = el('div', (o.identity && o.identity.name || o.displayName || 'ไม่ระบุชื่อ') + ' · ' + ROLES[o.role], 'occupant');

                line.dataset.role = o.role;
                card.appendChild(line);
            });
            if (!room.occupants.length) {
                card.appendChild(el('div', 'ไม่มีใครอยู่', 'empty'));
            }
            list.appendChild(card);
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
                    drawQueues(state.queues);
                    drawRooms(state.rooms);
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
