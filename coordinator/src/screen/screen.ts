/*
 * The coordinator screen. It shows the queues and the open rooms, and refreshes every few seconds. Everything it shows
 * is put in the page as text, never as markup: names come from the participants' tokens.
 */
(function() {
    const TOKEN_KEY = 'coordinator-token';
    const REFRESH_MS = 2000;

    /** How long a wait is before it is shown as long, and as too long. */
    const WAIT_WARN_SECONDS = 5 * 60;
    const WAIT_LONG_SECONDS = 15 * 60;

    /** How long a notice that something went well stays; one that something went wrong stays until it is closed. */
    const OK_NOTICE_MS = 5000;

    /** How long a room asked for from the queue stays picked out. */
    const SPOTLIGHT_MS = 3000;
    const SVG_NS = 'http://www.w3.org/2000/svg';
    const STAGES: [string, string, string][] = [
        [ 'waiting', 'รอคิว', 'clock' ],
        [ 'intake', 'ให้ข้อมูลก่อนพบแพทย์', 'clipboard' ],
        [ 'examination', 'พบแพทย์', 'stethoscope' ],
        [ 'aftercare', 'หลังพบแพทย์', 'heart' ]
    ];
    const STAGE_NAMES: Record<string, string> = { aftercare: 'หลังพบแพทย์',
        intake: 'ให้ข้อมูลก่อนพบแพทย์' };

    /** The kinds of room, in the order they are shown, with their name and icon. */
    const KINDS: [string, string, string][] = [
        [ 'patient', 'ห้องผู้ป่วย', 'door' ],
        [ 'station', 'จุดบริการ', 'stethoscope' ],
        [ 'lounge', 'ห้องพักเจ้าหน้าที่', 'coffee' ]
    ];
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
    const OUTCOME_ICONS: Record<string, string> = { cancelled: 'x',
        done: 'check',
        failed: 'alert',
        refused: 'ban' };
    const NOTICE_ICONS: Record<string, string> = { error: 'alert',
        ok: 'check',
        warn: 'alert' };

    interface IOccupant {
        displayName?: string;
        endpointId: string;
        identity?: { name?: string; };
        ownRoom?: string;
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
        destination?: string;
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

    interface IState {
        coordinator: { id: string; name?: string; };
        moves: IMove[];
        queues: Record<string, IQueueEntry[]>;
        rooms: IRoom[];
    }

    /** What the coordinator has chosen in the lists and typed in the fields, kept across the redraws. */
    const choices: Record<string, string> = {};

    /** The name of everyone seen, by endpoint, so that a move can be described after the person has gone. */
    const names: Record<string, string> = {};

    /** Which rooms are shown: those whose name or occupants hold the text, of the kind, if one is chosen. */
    const filter = { kind: '',
        text: '' };

    /** The room picked out from the queue, until when. */
    let spotlight = { room: '',
        until: 0 };
    let noticeTimer: ReturnType<typeof setTimeout> | undefined;
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
     * Calls an acting route of the screen's API. A request that does not reach the service has the status 0.
     *
     * @param {string} path - The route.
     * @param {Object} body - What to send.
     * @returns {Promise<Object>} The status and the body.
     */
    async function act(path: string, body: object): Promise<IResult> {
        try {
            const response = await fetch(`screen/api${path}`, {
                body: JSON.stringify(body),
                headers: { Authorization: `Bearer ${sessionStorage.getItem(TOKEN_KEY)}`,
                    'Content-Type': 'application/json' },
                method: 'POST'
            });
            const json = await response.json().catch(() => {
                return {};
            });

            return { body: json,
                status: response.status };
        } catch {
            return { body: {},
                status: 0 };
        }
    }

    /**
     * Whether a request failed.
     *
     * @param {Object} result - What came of it.
     * @returns {boolean}
     */
    function failed(result: IResult): boolean {
        return result.status === 0 || result.status >= 400;
    }

    /**
     * Tells the coordinator what came of a request. Good news goes by itself; bad news stays until it is closed or
     * the next request.
     *
     * @param {string} text - What, or nothing to stop telling.
     * @param {string} tone - Whether it went well: ok, warn or error.
     * @returns {void}
     */
    function say(text?: string, tone = 'warn'): void {
        const notice = $('notice');

        clearTimeout(noticeTimer);
        notice.hidden = !text;
        notice.dataset.tone = tone;
        $('notice-icon').setAttribute('href', `#i-${NOTICE_ICONS[tone] || 'info'}`);
        $('notice-text').textContent = text || '';
        if (text && tone === 'ok') {
            noticeTimer = setTimeout(() => say(), OK_NOTICE_MS);
        }
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
     * Makes an icon, drawn from the page's own set.
     *
     * @param {string} name - Which.
     * @returns {SVGSVGElement}
     */
    function icon(name: string): SVGSVGElement {
        const svg = document.createElementNS(SVG_NS, 'svg');
        const use = document.createElementNS(SVG_NS, 'use');

        svg.setAttribute('class', 'i');
        svg.setAttribute('aria-hidden', 'true');
        svg.setAttribute('focusable', 'false');
        use.setAttribute('href', `#i-${name}`);
        svg.appendChild(use);

        return svg;
    }

    /**
     * Makes a button with an icon and text.
     *
     * @param {string} text - The text.
     * @param {string} className - The class.
     * @param {string} iconName - The icon, if any.
     * @returns {HTMLButtonElement}
     */
    function button(text: string, className: string, iconName?: string): HTMLButtonElement {
        const node = el('button', undefined, className);

        node.type = 'button';
        if (iconName) {
            node.appendChild(icon(iconName));
        }
        node.appendChild(el('span', text));

        return node;
    }

    /**
     * Formats a waiting time, as a clock does.
     *
     * @param {number} seconds - How long.
     * @returns {string}
     */
    function waited(seconds: number): string {
        return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
    }

    /**
     * Describes a waiting time in words.
     *
     * @param {number} seconds - How long.
     * @returns {string}
     */
    function waitedInWords(seconds: number): string {
        if (seconds < 60) {
            return `${seconds} วินาที`;
        }

        return `${Math.floor(seconds / 60)} นาที ${seconds % 60} วินาที`;
    }

    /**
     * Formats the time of day.
     *
     * @param {Date} date - When.
     * @returns {string}
     */
    function clock(date: Date): string {
        return date.toLocaleTimeString('th-TH', { hour: '2-digit',
            minute: '2-digit',
            second: '2-digit' });
    }

    /**
     * The letters that stand for a name: the first of the first two words in Latin script, or the first consonant of
     * a Thai name, past the vowels written before it.
     *
     * @param {string} name - The name.
     * @returns {string}
     */
    function initials(name: string): string {
        const words = name.trim().split(/\s+/).map(w => w.replace(/^[เแโใไ]+/, ''));
        const first = words[0]?.charAt(0) ?? '';

        if (/[A-Za-z]/.test(first) && /^[A-Za-z]/.test(words[1] ?? '')) {
            return (first + (words[1] ?? '').charAt(0)).toUpperCase();
        }

        return first.toUpperCase() || '?';
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
        say();
        $('signin').hidden = false;
        $('board').hidden = true;
        $('who').hidden = true;
        $('signin-error').hidden = !message;
        $('signin-error').textContent = message || '';
    }

    /**
     * Shows whether the screen is up to date.
     *
     * @param {boolean} ok - Whether the last refresh worked.
     * @returns {void}
     */
    function showLive(ok: boolean): void {
        $('live').dataset.state = ok ? 'ok' : 'down';
        $('live-text').textContent = ok ? `อัปเดต ${clock(new Date())}` : 'ขาดการเชื่อมต่อ';
    }

    /**
     * Draws the figures at the top.
     *
     * @param {Object} state - The state.
     * @returns {void}
     */
    function drawStats(state: IState): void {
        const waiting = state.queues.waiting ?? [];
        const longest = Math.max(0, ...waiting.map(e => e.waitedSeconds));
        const inStage = (stage: string) => (state.queues[stage] ?? []).length;
        const open = state.rooms.filter(r => r.open);
        const people = (role: string) => open.reduce((n, r) => n + r.occupants.filter(o => o.role === role).length, 0);

        $('stat-waiting').textContent = String(waiting.length);
        $('stat-waiting-note').textContent = waiting.length ? `นานสุด ${waitedInWords(longest)}` : 'ไม่มีผู้ป่วยรอ';
        $('stat-active').textContent = String(inStage('intake') + inStage('examination') + inStage('aftercare'));
        $('stat-active-note').textContent
            = `ให้ข้อมูล ${inStage('intake')} · พบแพทย์ ${inStage('examination')} · หลัง ${inStage('aftercare')}`;
        $('stat-rooms').textContent = `${open.length}/${state.rooms.length}`;
        $('stat-rooms-note').textContent = `ผู้ป่วย ${people('patient')} · เจ้าหน้าที่ ${people('staff')}`;
        $('stat-moving').textContent = String(state.moves.filter(isUnderWay).length);
    }

    /**
     * Whether a move is still under way.
     *
     * @param {Object} m - The move.
     * @returns {boolean}
     */
    function isUnderWay(m: IMove): boolean {
        return m.state === 'counting_down' || m.state === 'preparing';
    }

    /**
     * The stage that an encounter in a stage goes to by default: the next, or for the last, the one before.
     *
     * @param {number} index - The stage's place in the stages.
     * @returns {string}
     */
    function nextStage(index: number): string {
        return (STAGES[index + 1] ?? STAGES[index - 1])[0];
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
        list.className = 'board';
        STAGES.forEach(([ id, name, iconName ], index) => {
            const column = el('div', undefined, 'card queue');
            const entries = queues[id] ?? [];
            const title = el('h3');

            column.id = `queue-${id}`;
            column.dataset.stage = id;
            title.appendChild(el('span', undefined, 'tile')).appendChild(icon(iconName));
            title.appendChild(el('span', name));
            title.appendChild(el('span', String(entries.length), 'count'));
            column.appendChild(title);
            if (!entries.length) {
                column.appendChild(el('div', 'ไม่มีผู้ป่วยรอ', 'empty'));
            }
            entries.forEach((entry, position) => column.appendChild(drawTicket(entry, position, index)));
            list.appendChild(column);
        });
    }

    /**
     * Draws one encounter in a queue: the entry, and right after it, its controls.
     *
     * @param {Object} entry - The entry.
     * @param {number} position - Its place in the queue.
     * @param {number} index - The stage's place in the stages.
     * @returns {HTMLElement}
     */
    function drawTicket(entry: IQueueEntry, position: number, index: number): HTMLElement {
        const stage = STAGES[index][0];
        const last = index === STAGES.length - 1;
        const ticket = el('div', undefined, 'ticket');
        const row = el('div', undefined, `queue-entry${entry.suggested ? ' suggested' : ''}`);
        const hn = button(entry.hn || '—', 'hn-link');
        const tier = entry.waitedSeconds >= WAIT_LONG_SECONDS ? 'long' : entry.waitedSeconds >= WAIT_WARN_SECONDS ? 'warn' : '';
        const wait = el('span', undefined, `wait ${tier}`);

        row.dataset.encounter = entry.encounterId;
        row.appendChild(el('span', String(position + 1), 'position'));
        hn.title = 'ดูห้องของผู้ป่วย';
        hn.addEventListener('click', () => revealRoom(entry.hn || ''));
        row.appendChild(hn);
        if (entry.suggested) {
            row.appendChild(el('span', 'ถัดไป', 'badge next'));
        }
        wait.title = `รอมาแล้ว ${waitedInWords(entry.waitedSeconds)}`;
        wait.appendChild(icon('clock'));
        wait.appendChild(el('span', waited(entry.waitedSeconds)));
        row.appendChild(wait);

        const key = `stage|${entry.encounterId}`;
        const pick = el('select', undefined, 'stage-to');

        pick.setAttribute('aria-label', `ส่ง ${entry.hn || ''} ไปขั้น`);
        STAGES.filter(s => s[0] !== stage).forEach(([ value, name ]) => {
            const option = el('option', name);

            option.value = value;
            pick.appendChild(option);
        });
        pick.value = choices[key] || nextStage(index);
        pick.addEventListener('change', () => {
            choices[key] = pick.value;
        });

        const go = button('ส่งต่อ', `stage-go ${last ? 'secondary' : 'primary'}`, 'arrow');
        const done = button('เสร็จสิ้น', `stage-done ${last ? 'primary' : 'secondary'}`, 'check');

        go.addEventListener('click', () => {
            delete choices[key];
            changeStage(entry, pick.value, go);
        });
        done.addEventListener('click', () => changeStage(entry, 'done', done));

        const controls = el('div', undefined, 'controls');

        controls.append(pick, go, done);
        ticket.append(row, controls);

        return ticket;
    }

    /**
     * Brings a patient's room into view and picks it out for a moment.
     *
     * @param {string} hn - The patient's HN, which names the room.
     * @returns {void}
     */
    function revealRoom(hn: string): void {
        const name = hn.toLowerCase();
        const card = Array.from(document.querySelectorAll<HTMLElement>('.room'))
            .find(c => c.dataset.room?.toLowerCase() === name);

        if (!card) {
            say(`ห้อง ${hn} ยังไม่เปิด`, 'warn');

            return;
        }
        if (card.hidden) {
            setFilter('', '');
        }
        spotlight = { room: card.dataset.room ?? '',
            until: Date.now() + SPOTLIGHT_MS };
        card.classList.add('spotlight');
        card.scrollIntoView({ behavior: matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth',
            block: 'center' });
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
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function move(room: string, endpointId: string, destination: string, trigger: HTMLButtonElement): void {
        if (!destination) {
            return;
        }
        trigger.disabled = true;
        act('/moves', { from: { endpointId,
            room },
        to: { room: destination } }).then(result => {
            if (failed(result)) {
                say(result.status === 503 || result.status === 0 ? 'ติดต่อระบบไม่ได้ ย้ายไม่สำเร็จ' : 'ย้ายไม่สำเร็จ', 'error');
            } else if (result.body.state === 'refused') {
                say(`${OUTCOMES.refused}: ${REASONS[result.body.reason ?? ''] || result.body.reason}`, 'warn');
            } else {
                say(`ส่งคำขอย้าย ${names[endpointId] || 'ผู้เข้าร่วม'} ไป ${destination} แล้ว`, 'ok');
            }
            refresh();
        });
    }

    /**
     * Puts an encounter in a stage.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function changeStage(entry: IQueueEntry, stage: string, trigger: HTMLButtonElement): void {
        const hn = entry.hn || 'ผู้ป่วย';

        trigger.disabled = true;
        act(`/encounters/${encodeURIComponent(entry.encounterId)}/stage`, { stage }).then(result => {
            if (result.status === 409) {
                say('encounter นี้เสร็จสิ้นแล้ว', 'warn');
            } else if (failed(result)) {
                say('เปลี่ยนขั้นไม่สำเร็จ', 'error');
            } else if (stage === 'done') {
                say(`${hn} เสร็จสิ้นแล้ว`, 'ok');
            } else {
                say(`ส่ง ${hn} ไปขั้น “${STAGES.find(s => s[0] === stage)?.[1] ?? stage}” แล้ว`, 'ok');
            }
            refresh();
        });
    }

    /**
     * Draws the rooms and who is in them, a group for each kind of room.
     *
     * @param {Object[]} rooms - The rooms.
     * @param {Object[]} moves - The moves under way and recent.
     * @returns {void}
     */
    function drawRooms(rooms: IRoom[], moves: IMove[]): void {
        const list = $('rooms');

        list.textContent = '';
        KINDS.forEach(([ kind, name, iconName ]) => {
            const ofKind = rooms.filter(r => r.kind === kind)
                .sort((a, b) => Number(b.open) - Number(a.open) || a.name.localeCompare(b.name));

            if (!ofKind.length) {
                return;
            }

            const group = el('div', undefined, 'room-group');
            const head = el('h3', undefined, 'group-head');
            const grid = el('div', undefined, 'grid');

            group.dataset.kind = kind;
            head.append(icon(iconName), el('span', name), el('span', String(ofKind.length), 'count'));
            ofKind.forEach(room => grid.appendChild(drawRoom(room, rooms, moves)));
            group.append(head, grid);
            list.appendChild(group);
        });
        document.querySelectorAll<HTMLElement>('#kind-filter button').forEach(b => {
            const count = b.dataset.kind ? rooms.filter(r => r.kind === b.dataset.kind).length : rooms.length;

            b.dataset.count = String(count);
        });
        applyRoomFilter();
    }

    /**
     * Draws a room's card.
     *
     * @param {Object} room - The room.
     * @param {Object[]} rooms - Every room, to move to.
     * @param {Object[]} moves - The moves under way and recent.
     * @returns {HTMLElement}
     */
    function drawRoom(room: IRoom, rooms: IRoom[], moves: IMove[]): HTMLElement {
        const card = el('div', undefined, 'card room');
        const head = el('div', undefined, 'room-head');
        const title = el('div', undefined, 'room-title');
        const badges = el('div', undefined, 'badges');
        const people = room.occupants.filter(o => o.role !== 'hidden');
        const unstarted = room.kind === 'patient' && room.open && !room.encounterId;

        card.dataset.room = room.name;
        card.dataset.kind = room.kind;
        card.dataset.open = String(room.open);
        card.dataset.search = [ room.name, ...room.occupants.map(o => o.identity?.name || o.displayName || '') ]
            .join(' ').toLowerCase();
        if (spotlight.room === room.name && Date.now() < spotlight.until) {
            card.classList.add('spotlight');
        }
        head.appendChild(el('span', undefined, 'tile')).appendChild(icon(KINDS.find(k => k[0] === room.kind)?.[2] ?? 'door'));
        title.append(el('h4', room.name), el('span', kindName(room), 'kind-name'));
        head.appendChild(title);
        if (!room.open) {
            badges.appendChild(el('span', 'ปิดอยู่', 'badge'));
        }
        if (unstarted) {
            badges.appendChild(el('span', 'ยังไม่มี encounter', 'badge warn'));
        }
        if (people.length !== room.occupants.length) {
            badges.appendChild(el('span', 'กำลังบันทึก', 'badge rec'));
        }
        head.appendChild(badges);
        card.appendChild(head);
        if (unstarted) {
            const start = button('เริ่ม encounter', 'start-encounter primary', 'play');

            start.addEventListener('click', () => {
                start.disabled = true;
                act('/encounters', { hn: room.name }).then(result => {
                    say(failed(result) ? 'เริ่ม encounter ไม่สำเร็จ (ระบบบันทึกอาจเต็ม)' : `เริ่ม encounter ของ ${room.name} แล้ว`,
                        failed(result) ? 'error' : 'ok');
                    refresh();
                });
            });
            card.appendChild(start);
        }
        people.forEach(o => card.appendChild(drawOccupant(o, room, rooms, moves)));
        if (!people.length) {
            card.appendChild(el('div', 'ไม่มีใครอยู่', 'empty'));
        }

        return card;
    }

    /**
     * Draws someone in a room, and how to move them, unless they are being moved.
     *
     * @param {Object} o - The occupant.
     * @param {Object} room - Their room.
     * @param {Object[]} rooms - Every room, to move to.
     * @param {Object[]} moves - The moves under way and recent.
     * @returns {HTMLElement}
     */
    function drawOccupant(o: IOccupant, room: IRoom, rooms: IRoom[], moves: IMove[]): HTMLElement {
        const who = (o.identity?.name) || o.displayName || 'ไม่ระบุชื่อ';
        const line = el('div', undefined, 'occupant');
        const person = el('div', undefined, 'person');
        const label = el('div', undefined, 'person-text');
        const moving = moves.find(m => isUnderWay(m) && m.origin === room.name && m.endpointId === o.endpointId);

        names[o.endpointId] = who;
        line.dataset.role = o.role;
        line.dataset.endpoint = o.endpointId;
        label.append(el('span', who, 'person-name'), el('span', ROLES[o.role] || o.role, 'person-role'));
        person.append(el('span', initials(who), 'avatar'), label);
        line.appendChild(person);
        if (moving) {
            const badge = el('span', `กำลังย้ายไป ${moving.destination || '…'}`, 'badge moving');

            badge.title = moving.state === 'preparing' ? 'กำลังเตรียมระบบบันทึกที่ปลายทาง' : 'ผู้ถูกย้ายเห็นการนับถอยหลังอยู่';
            line.appendChild(badge);
        } else if (o.role === 'patient' || o.role === 'staff') {
            line.appendChild(moveControls(o, room, rooms));
        }

        return line;
    }

    /**
     * Draws the controls that move someone: the rooms they may go to and, for staff, a field for a room by its HN.
     *
     * @param {Object} o - The occupant.
     * @param {Object} room - Their room.
     * @param {Object[]} rooms - Every room.
     * @returns {HTMLElement}
     */
    function moveControls(o: IOccupant, room: IRoom, rooms: IRoom[]): HTMLElement {
        const key = `move|${room.name}|${o.endpointId}`;
        const controls = el('div', undefined, 'move');
        const pick = el('select', undefined, 'move-to');
        const go = button('ย้าย', 'move-go primary', 'arrow');

        // Staff may be sent to a closed patient's room that is in no list: the coordinator names it by the HN.
        // A patient has no such input: their own room is always in the list, and no other patient's room is allowed.
        const typed = o.role === 'patient' ? undefined : el('input', undefined, 'move-hn');
        const destination = () => (typed?.value.trim() ?? '') || pick.value;
        const update = () => {
            go.disabled = !destination();
        };

        pick.setAttribute('aria-label', `ย้าย ${names[o.endpointId]} ไปห้อง`);
        addDestinations(pick, o, room, rooms);
        pick.value = choices[key] || '';
        pick.addEventListener('change', () => {
            choices[key] = pick.value;
            update();
        });
        controls.appendChild(pick);
        if (typed) {
            typed.type = 'text';
            typed.placeholder = 'หรือพิมพ์ HN';
            typed.autocomplete = 'off';
            typed.setAttribute('aria-label', 'HN ของห้องปลายทาง');
            typed.value = choices[`hn|${key}`] || '';
            typed.addEventListener('input', () => {
                choices[`hn|${key}`] = typed.value;
                update();
            });
            typed.addEventListener('keydown', event => {
                if (event.key === 'Enter' && !go.disabled) {
                    go.click();
                }
            });
            controls.appendChild(typed);
        }
        go.addEventListener('click', () => {
            const to = destination();

            delete choices[key];
            delete choices[`hn|${key}`];
            move(room.name, o.endpointId, to, go);
        });
        update();
        controls.appendChild(go);

        return controls;
    }

    /**
     * Lists the rooms someone may be moved to, grouped by kind. A patient goes only into a station or their own room;
     * staff may go to any room (ADR 0005).
     *
     * @param {HTMLSelectElement} pick - The list.
     * @param {Object} o - The occupant.
     * @param {Object} room - Their room, which is not offered.
     * @param {Object[]} rooms - Every room.
     * @returns {void}
     */
    function addDestinations(pick: HTMLSelectElement, o: IOccupant, room: IRoom, rooms: IRoom[]): void {
        const blank = el('option', 'ย้ายไปห้อง…');

        // A patient's own room closes when they leave it, and the service lists only open patients' rooms: offer it
        // still, so that they can be moved back home.
        const own = o.role === 'patient' ? o.ownRoom : undefined;
        const candidates: IRoom[] = own && own !== room.name && !rooms.some(other => other.name === own)
            ? [ ...rooms, { kind: 'patient', name: own, occupants: [], open: false } ]
            : rooms;

        blank.value = '';
        pick.appendChild(blank);
        [ 'station', 'patient', 'lounge' ].forEach(kind => {
            const group = el('optgroup');

            group.label = KINDS.find(k => k[0] === kind)?.[1] ?? kind;
            candidates.filter(other => other.kind === kind && other.name !== room.name
                    && (o.role !== 'patient' || other.kind === 'station' || other.name === o.ownRoom))
                .forEach(other => {
                    const notes = [
                        other.kind === 'station' ? STAGE_NAMES[other.stage ?? ''] : '',
                        other.name === o.ownRoom ? 'ห้องของผู้ป่วยเอง' : '',
                        other.kind === 'station' && other.occupants.some(p => p.role === 'patient') ? 'มีผู้ป่วยอยู่' : ''
                    ].filter(Boolean);
                    const option = el('option',
                        other.name + (notes.length ? ` — ${notes.join(' · ')}` : '') + (other.open ? '' : ' (ปิดอยู่)'));

                    option.value = other.name;
                    group.appendChild(option);
                });
            if (group.children.length) {
                pick.appendChild(group);
            }
        });
    }

    /**
     * Shows only the rooms that the search and the chosen kind let through.
     *
     * @returns {void}
     */
    function applyRoomFilter(): void {
        let shown = 0;

        document.querySelectorAll<HTMLElement>('.room-group').forEach(group => {
            let inGroup = 0;

            group.querySelectorAll<HTMLElement>('.room').forEach(card => {
                card.hidden = Boolean((filter.kind && card.dataset.kind !== filter.kind)
                    || (filter.text && !card.dataset.search?.includes(filter.text)));
                inGroup += card.hidden ? 0 : 1;
            });
            group.hidden = !inGroup;
            shown += inGroup;
        });
        $('rooms-none').hidden = shown > 0;
        $('rooms-none').textContent = filter.kind || filter.text ? 'ไม่พบห้องที่ตรงกับการค้นหา' : 'ยังไม่มีห้อง';
    }

    /**
     * Chooses which rooms are shown.
     *
     * @param {string} text - The search.
     * @param {string} kind - The kind of room, or nothing for all.
     * @returns {void}
     */
    function setFilter(text: string, kind: string): void {
        filter.text = text.trim().toLowerCase();
        filter.kind = kind;
        $<HTMLInputElement>('room-filter').value = text;
        document.querySelectorAll<HTMLElement>('#kind-filter button').forEach(b => {
            b.setAttribute('aria-pressed', String((b.dataset.kind ?? '') === kind));
        });
        applyRoomFilter();
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
        moves.filter(m => OUTCOMES[m.state])
            .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
            .forEach(m => {
                const text = `${names[m.endpointId] || 'ผู้เข้าร่วม'}: ${OUTCOMES[m.state]}${
                    m.reason ? ` (${REASONS[m.reason] || m.reason})` : ''}`;
                const item = el('li', undefined, `outcome ${m.state}`);
                const body = el('div');

                item.dataset.move = m.id;
                body.append(el('span', text, 'outcome-text'),
                    el('span', `${m.origin} → ${m.destination || '?'} · ${clock(new Date(m.startedAt))}`, 'outcome-meta'));
                item.append(icon(OUTCOME_ICONS[m.state]), body);
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

                return response.json().then((state: IState) => {
                    const who = state.coordinator.name || state.coordinator.id;

                    $('signin').hidden = true;
                    $('board').hidden = false;
                    $('who').hidden = false;
                    $('who-name').textContent = who;
                    $('who-avatar').textContent = initials(who);
                    $('problem').hidden = true;
                    showLive(true);
                    drawStats(state);

                    // A list being chosen from would close, and a field being typed in would lose its place, if they
                    // were drawn again.
                    if (!document.activeElement?.matches('select, input.move-hn')) {
                        drawQueues(state.queues);
                        drawRooms(state.rooms, state.moves);
                    }
                    drawOutcomes(state.moves);
                });
            })
            .catch(() => {
                showLive(false);
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
    $('notice-close').addEventListener('click', () => say());
    $('room-filter').addEventListener('input', () => setFilter($<HTMLInputElement>('room-filter').value, filter.kind));
    document.querySelectorAll<HTMLElement>('#kind-filter button').forEach(b => {
        b.addEventListener('click', () => setFilter($<HTMLInputElement>('room-filter').value, b.dataset.kind ?? ''));
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
