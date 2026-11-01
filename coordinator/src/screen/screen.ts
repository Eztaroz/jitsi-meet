
/*
 * The coordinator screen. It shows the queues and the open rooms, and refreshes every few seconds. Everything it shows
 * is put in the page as text, never as markup: names come from the participants' tokens.
 */
(function() {
    const TOKEN_KEY = 'coordinator-token';
    const REFRESH_MS = 2000;
    const STAGES: [string, string][] = [
        [ 'waiting', 'รอคิว' ],
        [ 'intake', 'ให้ข้อมูลก่อนพบแพทย์' ],
        [ 'examination', 'พบแพทย์' ],
        [ 'aftercare', 'หลังพบแพทย์' ]
    ];
    const STAGE_NAMES: Record<string, string> = { aftercare: 'หลังพบแพทย์',
        intake: 'ให้ข้อมูลก่อนพบแพทย์' };
    const ROLES: Record<string, string> = { hidden: 'ระบบบันทึก',
        patient: 'ผู้ป่วย',
        staff: 'เจ้าหน้าที่',
        unknown: 'ไม่ทราบตัวตน' };
    const ERRORS: Record<string, string> = {
        'bad_signature': 'โทเคนนี้ไม่ได้ออกโดยระบบของโรงพยาบาล',
        expired: 'โทเคนหมดอายุแล้ว',
        malformed: 'โทเคนไม่ถูกต้อง',
        'no_identity': 'โทเคนนี้ไม่ระบุตัวผู้ใช้',
        'not_a_coordinator': 'บัญชีนี้ไม่ได้เป็นผู้ประสานงาน',
        'not_yet_valid': 'โทเคนยังใช้ไม่ได้',
        'unknown_key': 'ไม่รู้จักกุญแจของโทเคนนี้',
        'unsupported_algorithm': 'โทเคนไม่ถูกต้อง',
        'wrong_audience': 'โทเคนนี้ไม่ใช่สำหรับระบบนี้',
        'wrong_issuer': 'โทเคนนี้ไม่ได้ออกโดยระบบของโรงพยาบาล'
    };
    const REASONS: Record<string, string> = {
        'already_being_moved': 'กำลังย้ายผู้นี้อยู่แล้ว',
        'could_not_send_move': 'ส่งคำสั่งย้ายไม่ได้',
        'destination_holds_a_patient': 'ห้องปลายทางมีผู้ป่วยอยู่แล้ว',
        'destination_not_open': 'ห้องปลายทางยังไม่เปิด',
        'not_the_patients_room': 'ย้ายผู้ป่วยเข้าได้เฉพาะห้องของตนเองหรือห้องตรวจ',
        'participant_did_not_arrive': 'ผู้ถูกย้ายไม่ไปถึงห้องปลายทาง',
        'participant_not_found': 'ไม่พบผู้ที่จะย้ายในห้อง',
        'participant_not_movable': 'ย้ายผู้นี้ไม่ได้',
        'patient_into_lounge': 'ห้ามย้ายผู้ป่วยเข้าห้องพักเจ้าหน้าที่',
        'patient_room_unknown': 'ไม่ทราบห้องของผู้ป่วยรายนี้',
        'recorder_bot_at_capacity': 'ระบบบันทึกเต็ม ย้ายไม่ได้',
        'recorder_bot_not_ready': 'ระบบบันทึกไม่พร้อมภายใน 30 วินาที',
        'recorder_bot_unreachable': 'ติดต่อระบบบันทึกไม่ได้'
    };
    const OUTCOMES: Record<string, string> = { cancelled: 'ผู้ถูกย้ายกดยกเลิก',
        done: 'ย้ายสำเร็จ',
        failed: 'ย้ายไม่สำเร็จ',
        refused: 'ไม่อนุญาตให้ย้าย' };
    const ALL_STAGES: [string, string][] = STAGES.concat([ [ 'done', 'เสร็จสิ้น' ] ]);

    interface IOccupant {
        displayName?: string;
        endpointId: string;
        identity?: { name?: string; };
        role: string;
    }

    interface IRoom {
        encounterId?: string;
        kind: string;
        name: string;
        occupants: IOccupant[];
        open: boolean;
        stage?: string;
    }

    interface IMove {
        endpointId: string;
        id: string;
        origin: string;
        reason?: string;
        startedAt: string;
        state: string;
    }

    interface IQueueEntry {
        encounterId: string;
        hn?: string;
        suggested?: boolean;
        waitedSeconds: number;
    }

    interface IResult {
        body: { reason?: string; state?: string; };
        status: number;
    }

    /** What the coordinator has chosen in the lists, kept across the redraws. */
    const choices: Record<string, string> = {};

    /** The name of everyone seen, by endpoint, so that a move can be described after the person has gone. */
    const names: Record<string, string> = {};
    let timer: ReturnType<typeof setTimeout> | undefined;

    /**
     * Finds an element.
     *
     * @param {string} id - Its id.
     * @returns {HTMLElement}
     */
    function $<T extends HTMLElement = HTMLElement>(id: string): T {
        return document.getElementById(id) as T;
    }

    /**
     * Calls an acting route of the screen's API.
     *
     * @param {string} path - The route.
     * @param {Object} body - What to send.
     * @returns {Promise<Object>} The status and the body.
     */
    function act(path: string, body: object): Promise<IResult> {
        return fetch(`screen/api${path}`, {
            body: JSON.stringify(body),
            headers: { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}`,
                'Content-Type': 'application/json' },
            method: 'POST'
        }).then(response => response.json().catch(() => {
            return {};
        })
.then(json => {
    return { body: json,
        status: response.status };
}));
    }

    /**
     * Tells the coordinator what came of a request, until the next one.
     *
     * @param {string} text - What.
     * @returns {void}
     */
    function say(text?: string): void {
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
    function el<K extends keyof HTMLElementTagNameMap>(
            tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
        const node = document.createElement(tag);

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
    function waited(seconds: number): string {
        if (seconds < 60) {
            return `${seconds} วินาที`;
        }

        return `${Math.floor(seconds / 60)} นาที ${seconds % 60} วินาที`;
    }

    /**
     * Shows the sign-in form, with a reason if there is one.
     *
     * @param {string} message - Why, or nothing.
     * @returns {void}
     */
    function showSignIn(message?: string): void {
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
    function drawQueues(queues: Record<string, IQueueEntry[]>): void {
        const list = $('queue-list');

        list.textContent = '';
        list.className = 'grid';
        STAGES.forEach(stage => {
            const card = el('div', undefined, 'card');
            const entries = queues[stage[0]] ?? [];

            card.id = `queue-${stage[0]}`;
            const title = el('h3', stage[1]);

            title.appendChild(el('span', String(entries.length), 'badge'));
            card.appendChild(title);
            if (!entries.length) {
                card.appendChild(el('div', 'ไม่มีผู้ป่วยรอ', 'empty'));
            }
            entries.forEach(entry => {
                const row = el('div', undefined, `queue-entry${entry.suggested ? ' suggested' : ''}`);

                row.dataset.encounter = entry.encounterId;
                row.appendChild(el('span', entry.hn || ''));
                row.appendChild(el('span', waited(entry.waitedSeconds) + (entry.suggested ? ' · แนะนำคนถัดไป' : '')));

                const key = `stage|${entry.encounterId}`;
                const pick = el('select', undefined, 'stage-to');

                ALL_STAGES.forEach(choice => {
                    const option = el('option', choice[1]);

                    option.value = choice[0];
                    pick.appendChild(option);
                });
                pick.value = choices[key] || stage[0];
                pick.addEventListener('change', () => {
                    choices[key] = pick.value;
                });

                const go = el('button', 'เปลี่ยนขั้น', 'stage-go');

                go.type = 'button';
                go.addEventListener('click', () => {
                    changeStage(entry.encounterId, pick.value);
                });

                const done = el('button', 'เสร็จสิ้น', 'stage-done secondary');

                done.type = 'button';
                done.addEventListener('click', () => {
                    changeStage(entry.encounterId, 'done');
                });

                const controls = el('div', undefined, 'controls');

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
    function kindName(room: IRoom): string {
        if (room.kind === 'lounge') {
            return 'ห้องพักเจ้าหน้าที่';
        }
        if (room.kind === 'station') {
            return `จุดบริการ: ${STAGE_NAMES[room.stage ?? ''] || ''}`;
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
    function move(room: string, endpointId: string, destination: string): void {
        if (!destination) {
            return;
        }
        act('/moves', { from: { endpointId,
            room },
        to: { room: destination } }).then(result => {
            if (result.status >= 400) {
                say(result.status === 503 ? 'ติดต่อระบบไม่ได้ ย้ายไม่สำเร็จ' : 'ย้ายไม่สำเร็จ');
            } else if (result.body.state === 'refused') {
                say(`${OUTCOMES.refused}: ${REASONS[result.body.reason ?? ''] || result.body.reason}`);
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
    function changeStage(encounterId: string, stage: string): void {
        act(`/encounters/${encodeURIComponent(encounterId)}/stage`, { stage }).then(result => {
            if (result.status === 409) {
                say('encounter นี้เสร็จสิ้นแล้ว');
            } else {
                say(result.status >= 400 ? 'เปลี่ยนขั้นไม่สำเร็จ' : '');
            }
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
    function drawRooms(rooms: IRoom[], moves: IMove[]): void {
        const list = $('rooms');

        list.textContent = '';
        list.className = 'grid';
        rooms.forEach(room => {
            const card = el('div', undefined, 'card room');
            const title = el('h3', room.name);

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
                const start = el('button', 'เริ่ม encounter', 'start-encounter');

                start.type = 'button';
                start.addEventListener('click', () => {
                    act('/encounters', { hn: room.name }).then(result => {
                        say(result.status >= 400 ? 'เริ่ม encounter ไม่สำเร็จ (ระบบบันทึกอาจเต็ม)' : '');
                        refresh();
                    });
                });
                card.appendChild(start);
            }
            room.occupants.forEach(o => {
                const who = (o.identity?.name) || o.displayName || 'ไม่ระบุชื่อ';
                const line = el('div', undefined, 'occupant');
                const moving = moves.some(m => (m.state === 'counting_down' || m.state === 'preparing')
                    && m.origin === room.name && m.endpointId === o.endpointId);

                names[o.endpointId] = who;
                line.dataset.role = o.role;
                line.dataset.endpoint = o.endpointId;
                line.appendChild(el('span', `${who} · ${ROLES[o.role]}`));
                if (moving) {
                    line.appendChild(el('span', 'กำลังย้าย', 'badge moving'));
                } else if (o.role === 'patient' || o.role === 'staff') {
                    const key = `move|${room.name}|${o.endpointId}`;
                    const pick = el('select', undefined, 'move-to');
                    const blank = el('option', 'ย้ายไปห้อง…');

                    blank.value = '';
                    pick.appendChild(blank);
                    rooms.forEach(other => {
                        if (other.name !== room.name) {
                            const option = el('option', other.name + (other.open ? '' : ' (ปิดอยู่)'));

                            option.value = other.name;
                            pick.appendChild(option);
                        }
                    });
                    pick.value = choices[key] || '';
                    pick.addEventListener('change', () => {
                        choices[key] = pick.value;
                    });

                    // A patient's own room that is closed is in no list: the coordinator can name it by the HN.
                    const typed = el('input', undefined, 'move-hn');

                    typed.type = 'text';
                    typed.placeholder = 'หรือพิมพ์ HN';
                    typed.autocomplete = 'off';

                    const go = el('button', 'ย้าย', 'move-go');

                    go.type = 'button';
                    go.addEventListener('click', () => {
                        const to = typed.value.trim() || pick.value;

                        delete choices[key];
                        move(room.name, o.endpointId, to);
                    });
                    line.appendChild(pick);
                    line.appendChild(typed);
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
    function drawOutcomes(moves: IMove[]): void {
        const list = $('outcomes');

        list.textContent = '';
        moves.filter(m => OUTCOMES[m.state]).sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
.forEach(m => {
    const text = `${names[m.endpointId] || 'ผู้เข้าร่วม'}: ${OUTCOMES[m.state]
    }${m.reason ? ` (${REASONS[m.reason] || m.reason})` : ''}`;
    const item = el('li', text, `outcome ${m.state}`);

    item.dataset.move = m.id;
    list.appendChild(item);
});
    }

    /**
     * Reads the state from the service and draws it.
     *
     * @returns {void}
     */
    function refresh(): void {
        const token = sessionStorage.getItem(TOKEN_KEY);

        if (!token) {
            showSignIn();

            return;
        }
        fetch('screen/api/state', { headers: { Authorization: `Bearer ${token}` } })
            .then(response => {
                if (response.status === 401 || response.status === 403) {
                    return response.json().then((body: { error: string; }) => {
                        showSignIn(ERRORS[body.error] || 'เข้าสู่ระบบไม่ได้');
                    });
                }
                if (!response.ok) {
                    throw new Error('state');
                }

                return response.json().then((state: {
                    coordinator: { id: string; name?: string; };
                    moves: IMove[];
                    queues: Record<string, IQueueEntry[]>;
                    rooms: IRoom[];
                }) => {
                    $('signin').hidden = true;
                    $('board').hidden = false;
                    $('who').hidden = false;
                    $('who-name').textContent = state.coordinator.name || state.coordinator.id;
                    $('problem').hidden = true;

                    // A list that is being chosen from would close if it were drawn again.
                    if (!document.activeElement || document.activeElement.tagName !== 'SELECT') {
                        drawQueues(state.queues);
                        drawRooms(state.rooms, state.moves);
                    }
                    drawOutcomes(state.moves);
                });
            })
            .catch(() => {
                $('problem').hidden = false;
                $('problem').textContent = 'ติดต่อระบบไม่ได้ กำลังลองใหม่';
            })
            .then(() => {
                clearTimeout(timer);
                if (sessionStorage.getItem(TOKEN_KEY)) {
                    timer = setTimeout(refresh, REFRESH_MS);
                }
            });
    }

    $('signin-form').addEventListener('submit', event => {
        event.preventDefault();
        sessionStorage.setItem(TOKEN_KEY, $<HTMLInputElement>('signin-token').value.trim());
        $<HTMLInputElement>('signin-token').value = '';
        refresh();
    });
    $('sign-out').addEventListener('click', () => {
        showSignIn();
    });

    // A single sign-on can send the coordinator here with the token in the address's fragment, which a server never
    // sees.
    const fromFragment = /[#&]jwt=([^&]+)/.exec(location.hash);

    if (fromFragment) {
        sessionStorage.setItem(TOKEN_KEY, decodeURIComponent(fromFragment[1] ?? ''));
        history.replaceState(null, '', location.pathname);
    }
    refresh();
})();
