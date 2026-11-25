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

    /**
     * The three wait tiers, with their label and icon. A tier is a status: the legend shows its icon and its words,
     * never its colour alone.
     */
    const TIERS: [Tier, string, string][] = [
        [ 'ok', 'ไม่ถึง 5 นาที', 'check' ],
        [ 'warn', '5–15 นาที', 'clock' ],
        [ 'long', 'เกิน 15 นาที', 'alert' ]
    ];

    /** How long a notice that something went well stays; one that something went wrong stays until it is closed. */
    const OK_NOTICE_MS = 5000;

    /** How long a room asked for from the queue stays picked out. */
    const SPOTLIGHT_MS = 3000;
    const SVG_NS = 'http://www.w3.org/2000/svg';

    /** The icons of the stages that have one; any other stage gets the clipboard. */
    const STAGE_ICONS: Record<string, string> = { aftercare: 'heart',
        examination: 'stethoscope',
        waiting: 'clock' };

    /**
     * The stages that have a queue, with their name and icon, and every stage's name: both come from the pathways in
     * the service's configuration, with each state.
     */
    let STAGES: [string, string, string][] = [];
    let STAGE_NAMES: Record<string, string> = {};

    /** The encounters a waiting video is playing for now. */
    let PLAYING_VIDEOS = new Set<string>();

    /** The waiting videos a patient's video can be chosen from. */
    let VIDEO_CATALOGUE: { id: string; title: string; }[] = [];

    /** What a patient's room without an encounter says of the HIS's appointments today (ADR 0019): label and hint. */
    const APPOINTMENT_BADGES: Record<'all_seen' | 'none' | 'unreadable', [string, string]> = {
        all_seen: [ 'นัดวันนี้ครบแล้ว', 'ทุกนัดของวันนี้มี encounter แล้ว กด "เริ่ม encounter" ถ้าจะรับเพิ่ม' ],
        none: [ 'ไม่มีนัดวันนี้', 'HIS ไม่มีนัดของ HN นี้วันนี้ กด "เริ่ม encounter" ถ้าจะรับ' ],
        unreadable: [ 'อ่านนัดจาก HIS ไม่ได้', 'จะลองอ่านใหม่ในหนึ่งนาที หรือกด "เริ่ม encounter" เอง' ]
    };

    /** Each NHSO authentication status, as the queue shows it (ADR 0020): label and hint. */
    const NHSO_LABELS: Record<NhsoStatus, [string, string]> = {
        authenticated: [ 'สปสช. ยืนยันแล้ว', 'ผู้ป่วยยืนยันตัวตนในแอป สปสช. แล้ว' ],
        bypassed: [ 'สปสช. bypass', 'วันนี้ประกาศ bypass แล้ว: สปสช. นับทุกการมารับบริการของวันนี้ว่ายืนยันแล้ว' ],
        not_yet: [ 'สปสช. ยังไม่ยืนยัน', 'ยังรับบริการต่อได้ ให้พยาบาลชวนผู้ป่วยยืนยันในแอป สปสช. ระหว่างรอ' ],
        unavailable: [ 'สปสช. ตรวจไม่ได้', 'ตอนนี้ถาม API ของ สปสช. ไม่ได้ ถ้าล่มทั้งวันให้ประกาศ bypass' ]
    };

    /** The NHSO authentication of each open encounter, by id, as the last refresh found it. */
    let NHSO_STATUSES: Record<string, NhsoStatus> = {};

    /** The kinds of room, in the order they are shown, with their name and icon. */
    const KINDS: [string, string, string][] = [
        [ 'patient', 'ห้องผู้ป่วย', 'door' ],
        [ 'lounge', 'ห้องพักเจ้าหน้าที่', 'coffee' ]
    ];
    const ROLES: Record<string, string> = { hidden: 'ระบบบันทึก',
        patient: 'ผู้ป่วย',
        staff: 'เจ้าหน้าที่',
        unknown: 'ไม่ทราบตัวตน',
        'video_player': 'ตัวเล่นวิดีโอ' };
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
        'destination_not_open': 'ห้องปลายทางยังไม่เปิด',
        'participant_did_not_arrive': 'ผู้ถูกย้ายไม่ไปถึงห้องปลายทาง',
        'participant_not_found': 'ไม่พบผู้ที่จะย้ายในห้อง',
        'participant_not_movable': 'ย้ายผู้นี้ไม่ได้',
        'patient_moves_retired': 'ยกเลิกแล้ว เพราะระบบไม่ย้ายผู้ป่วยอีกต่อไป',
        'patients_never_move': 'ผู้ป่วยอยู่ในห้องของตนเองตลอด เจ้าหน้าที่เป็นฝ่ายเข้าไปหา'
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
        role: string;
    }

    interface IRoom {

        /** For a patient's room without an encounter, what the HIS said of their appointments today (ADR 0019). */
        appointment?: 'all_seen' | 'none' | 'unreadable';
        encounterId?: string;
        kind: string;
        name: string;
        occupants: IOccupant[];
        open: boolean;
        stages?: string[];

        /** The room's consultation is not being recorded: its recorder bot was lost and no other had room. */
        unrecorded?: boolean;
    }

    type Tier = 'long' | 'ok' | 'warn';

    type NhsoStatus = 'authenticated' | 'bypassed' | 'not_yet' | 'unavailable';

    interface IBypassDay {
        day: string;
        declaredAt: string;
        declaredBy: string;
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

        /** The stations whose staff are in the patient's room now. */
        at?: string[];
        encounterId: string;
        hn?: string;
        suggested?: boolean;
        waitedSeconds: number;
    }

    /** Examination's queue split by doctor, and the patients with no doctor yet. */
    interface IExamination {
        doctors: Record<string, IQueueEntry[]>;
        unassigned: IQueueEntry[];
    }

    interface IResult {
        body: { reason?: string; state?: string; };
        status: number;
    }

    interface ISentQuestionnaire {
        answers?: number[];
        closedAt?: string;
        id: string;
        questions: { choices: string[]; text: string; }[];
        title: string;
    }

    interface IQuestionnaires {
        catalogue: { id: string; title: string; }[];
        sent: Record<string, ISentQuestionnaire[]>;
    }

    interface IState {
        coordinator: { id: string; name?: string; };
        examination: IExamination;
        moves: IMove[];

        /** Today's NHSO bypass day, if one was declared, and each open encounter's authentication (ADR 0020). */
        nhso?: { bypass: IBypassDay | null; statuses: Record<string, NhsoStatus>; };
        questionnaires?: IQuestionnaires;
        queues: Record<string, IQueueEntry[]>;
        rooms: IRoom[];
        stages: { id: string; name: string; }[];
        teams: ITeam[];
        videoCatalogue?: { id: string; title: string; }[];
        videos?: { encounterId: string; }[];
    }

    interface ITeamMember {
        endpointId: string;
        name: string;
    }

    interface ITeam {
        busy: (ITeamMember & { hn: string; })[];
        free: ITeamMember[];
        id: string;
        lounge: string;
        stages: string[];
    }

    /**
     * What the coordinator has chosen in the move lists and typed in their fields, kept across the redraws of the
     * rooms. The queue view needs none of it: its elements are kept and patched.
     */
    const choices: Record<string, string> = {};

    /**
     * The elements of the queue view, by key. Each refresh patches them in place rather than draw them anew, so that
     * an open card, a half-typed field, a chosen option and the focus survive it. A card is one element for as long as
     * its encounter stays in one stage.
     */
    const teamNodes = new Map<string, HTMLDetailsElement>();
    const columnNodes = new Map<string, HTMLElement>();
    const groupNodes = new Map<string, HTMLElement>();
    const ticketNodes = new Map<string, HTMLElement>();

    /** The health questionnaires the deployment offers, and those sent to each open encounter, from the last refresh. */
    let questionnaires: IQuestionnaires = { catalogue: [],
        sent: {} };

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
     * Returns the element kept under a key, making it the first time.
     *
     * @param {Map} nodes - The elements kept.
     * @param {string} key - The key.
     * @param {Function} create - Makes the element.
     * @returns {HTMLElement}
     */
    function kept<T extends HTMLElement>(nodes: Map<string, T>, key: string, create: () => T): T {
        const node = nodes.get(key) ?? create();

        nodes.set(key, node);

        return node;
    }

    /**
     * Makes these elements an element's children, in this order. One that is already in its place is not touched.
     *
     * @param {Element} parent - The element.
     * @param {Element[]} children - Its children to be.
     * @returns {void}
     */
    function arrange(parent: Element, children: Element[]): void {
        const wanted = new Set(children);

        Array.from(parent.children).filter(child => !wanted.has(child))
            .forEach(child => child.remove());
        children.forEach((child, i) => {
            if (parent.children[i] !== child) {
                parent.insertBefore(child, parent.children[i] ?? null);
            }
        });
    }

    /**
     * Sets an element's text, leaving it alone when it already says so.
     *
     * @param {Element} node - The element.
     * @param {string} text - The text.
     * @returns {void}
     */
    function setText(node: Element, text: string): void {
        if (node.textContent !== text) {
            node.textContent = text;
        }
    }

    /**
     * Whether what an element was last drawn from has changed; if so, it is remembered.
     *
     * @param {HTMLElement} node - The element.
     * @param {*} from - What it is drawn from.
     * @returns {boolean}
     */
    function changed(node: HTMLElement, from: unknown): boolean {
        const drawn = JSON.stringify(from);

        if (node.dataset.drawn === drawn) {
            return false;
        }
        node.dataset.drawn = drawn;

        return true;
    }

    /**
     * Fills a list to choose from, when what it offers has changed, keeping the choice if it is still offered.
     *
     * @param {HTMLSelectElement} pick - The list.
     * @param {Array} options - The value and text of each option.
     * @returns {void}
     */
    function offer(pick: HTMLSelectElement, options: [string, string][]): void {
        if (!changed(pick, options)) {
            return;
        }

        const chosen = pick.value;

        pick.textContent = '';
        options.forEach(([ value, text ]) => pick.appendChild(el('option', text)).setAttribute('value', value));
        pick.value = options.some(o => o[0] === chosen) ? chosen : options[0]?.[0] ?? '';
    }

    /**
     * Holds a button down while what it asked for is done and shown.
     *
     * @param {HTMLButtonElement} trigger - The button.
     * @param {Promise} request - The request.
     * @param {Function} tell - Tells what came of it.
     * @returns {void}
     */
    function hold(trigger: HTMLButtonElement, request: Promise<IResult>, tell: (result: IResult) => void): void {
        trigger.disabled = true;
        request.then(result => {
            tell(result);

            return refresh();
        }).then(() => {
            trigger.disabled = false;
        });
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
        $('head').hidden = true;
        showNhsoControl(false);
        showView('queue');
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
     * Takes the stages from the pathways: `done` has no queue.
     *
     * @param {Object[]} stages - The stages, in order.
     * @returns {void}
     */
    function useStages(stages: { id: string; name: string; }[]): void {
        STAGES = stages.filter(stage => stage.id !== 'done')
            .map(stage => [ stage.id, stage.name, STAGE_ICONS[stage.id] ?? 'clipboard' ]);
        STAGE_NAMES = Object.fromEntries(stages.map(stage => [ stage.id, stage.name ]));
    }

    /**
     * Draws the figures in the header; what a figure is made of is its hint.
     *
     * @param {Object} state - The state.
     * @returns {void}
     */
    function drawStats(state: IState): void {
        const waiting = state.queues.waiting ?? [];
        const longest = Math.max(0, ...waiting.map(e => e.waitedSeconds));
        const inStage = (stage: string) => (state.queues[stage] ?? []).length;
        const active = STAGES.filter(stage => stage[0] !== 'waiting');
        const open = state.rooms.filter(r => r.open);
        const people = (role: string) => open.reduce((n, r) => n + r.occupants.filter(o => o.role === role).length, 0);
        const figure = (id: string, value: number, hint: string) => {
            $(id).textContent = String(value);
            ($(id).parentElement as HTMLElement).title = hint;
        };

        figure('stat-waiting', waiting.length,
            waiting.length ? `นานสุด ${waitedInWords(longest)}` : 'ไม่มีผู้ป่วยรอ');
        figure('stat-active', active.reduce((n, stage) => n + inStage(stage[0]), 0),
            active.map(stage => `${stage[1]} ${inStage(stage[0])}`).join(' · '));
        figure('stat-rooms', open.length, `เปิด ${open.length} จาก ${state.rooms.length} ห้อง · ผู้ป่วย ${
            people('patient')} · เจ้าหน้าที่ ${people('staff')}`);
        figure('stat-moving', state.moves.filter(isUnderWay).length, 'รอผู้ถูกย้ายไปถึงปลายทาง');
    }

    /**
     * Whether a move is still under way.
     *
     * @param {Object} m - The move.
     * @returns {boolean}
     */
    function isUnderWay(m: IMove): boolean {
        return m.state === 'counting_down';
    }

    /**
     * The stage the stage list offers first for an encounter: the next, or for the last, the one before.
     *
     * @param {number} index - The stage's place in the stages.
     * @returns {string}
     */
    function nextStage(index: number): string {
        return (STAGES[index + 1] ?? STAGES[index - 1] ?? STAGES[index])[0];
    }

    /**
     * Names the stages a station serves, as the screen shows them.
     *
     * @param {string[]} stages - The stage ids.
     * @returns {string}
     */
    function stageNames(stages: string[]): string {
        return stages.map(id => STAGE_NAMES[id] ?? id).join(' · ');
    }

    /**
     * The tier a wait falls in.
     *
     * @param {number} seconds - How long.
     * @returns {string}
     */
    function tierOf(seconds: number): Tier {
        if (seconds >= WAIT_LONG_SECONDS) {
            return 'long';
        }

        return seconds >= WAIT_WARN_SECONDS ? 'warn' : 'ok';
    }

    /**
     * How many of these entries wait in each tier.
     *
     * @param {Object[]} entries - Queue entries.
     * @returns {Object} The count by tier.
     */
    function tierCounts(entries: IQueueEntry[]): Record<Tier, number> {
        const counts = { long: 0,
            ok: 0,
            warn: 0 };

        entries.forEach(entry => counts[tierOf(entry.waitedSeconds)]++);

        return counts;
    }

    /**
     * Whether an encounter's patient is in their own room: it is open, with a patient in it.
     *
     * @param {Object|undefined} room - The encounter's room, if it has one.
     * @returns {boolean}
     */
    function isPatientIn(room?: IRoom): boolean {
        return Boolean(room?.open && room.occupants.some(o => o.role === 'patient'));
    }

    /**
     * Whether a patient waits to be called: they are in their own room, and no staff member is with them.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {Object[]} rooms - The rooms now.
     * @returns {boolean}
     */
    function awaitsCall(entry: IQueueEntry, rooms: IRoom[]): boolean {
        const room = rooms.find(r => r.kind === 'patient' && r.encounterId === entry.encounterId);

        return !entry.at?.length && isPatientIn(room) && !room?.occupants.some(o => o.role === 'staff');
    }

    /**
     * Makes what a column's head says of its queue: a bar of its wait tiers, then the longest wait, how many are past
     * the limit, and its station's free staff.
     *
     * @returns {HTMLElement}
     */
    function createColumnStats(): HTMLElement {
        const box = el('div', undefined, 'col-stats');
        const bar = el('div', undefined, 'tier-bar');
        const facts = el('div', undefined, 'col-facts');
        const fact = (className: string, iconName: string) => {
            const node = el('span', undefined, `col-fact ${className}`);

            node.append(icon(iconName), el('span'));

            return node;
        };

        bar.setAttribute('role', 'img');
        TIERS.forEach(([ tier ]) => bar.appendChild(el('span')).setAttribute('data-tier', tier));
        facts.append(fact('col-longest', 'clock'), fact('col-over', 'alert'), fact('col-staff', 'users'));
        box.append(bar, facts);

        return box;
    }

    /**
     * Brings a column's head up to date with the patients shown in the column.
     *
     * @param {HTMLElement} box - What createColumnStats made.
     * @param {Object[]} entries - The column's entries.
     * @param {Object[]} teams - The teams of the stations that serve its stage.
     * @param {Object[]} rooms - The rooms now.
     * @returns {void}
     */
    function updateColumnStats(box: HTMLElement, entries: IQueueEntry[], teams: ITeam[], rooms: IRoom[]): void {
        const find = (selector: string) => box.querySelector(selector) as HTMLElement;
        const counts = tierCounts(entries);

        TIERS.forEach(([ tier, label ]) => {
            const segment = find(`.tier-bar [data-tier="${tier}"]`);
            const count = counts[tier];

            segment.hidden = !count;
            segment.style.flexGrow = String(count);
            segment.title = `${label}: ${count} ราย (${Math.round(count * 100 / (entries.length || 1))}%)`;
        });
        find('.tier-bar').setAttribute('aria-label',
            TIERS.map(([ tier, label ]) => `${label} ${counts[tier]} ราย`).join(', '));

        const longest = Math.max(0, ...entries.map(e => e.waitedSeconds));

        find('.col-longest').dataset.tier = tierOf(longest);
        setText(find('.col-longest span'), `นานสุด ${waited(longest)}`);
        find('.col-over').hidden = !counts.long;
        setText(find('.col-over span'), `เกินเกณฑ์ ${counts.long}`);

        // A stage that no station serves says nothing of staff.
        const staff = find('.col-staff');
        const free = teams.reduce((n, team) => n + team.free.length, 0);
        const callable = entries.some(entry => awaitsCall(entry, rooms));
        let mood = '';
        let text = `ว่าง ${free} คน`;

        if (callable && free) {
            mood = 'idle';
            text += ' เรียกได้';
        } else if (callable) {
            mood = 'none';
            text = 'ไม่มีคนว่าง';
        }
        staff.hidden = !teams.length;
        staff.dataset.mood = mood;
        setText(find('.col-staff span'), text);

        const listed = (members: ITeamMember[]) => members.map(m => m.name || 'ไม่ระบุชื่อ').join(', ') || '—';

        staff.title = teams
            .map(team => `${team.id}: ว่าง ${listed(team.free)} · ไม่ว่าง ${listed(team.busy)}`)
            .join('\n');
    }

    /**
     * Draws the legend of the columns' wait bars, with the whole board's count in each tier.
     *
     * @param {Object} queues - The queues by stage.
     * @returns {void}
     */
    function drawLegend(queues: Record<string, IQueueEntry[]>): void {
        const legend = $('tier-legend');

        if (!legend.childElementCount) {
            legend.appendChild(el('span', 'เวลารอ', 'tier-legend-title'));
            TIERS.forEach(([ tier, label, iconName ]) => {
                const key = el('span', undefined, 'tier-key');

                key.dataset.tier = tier;
                key.append(el('i', undefined, 'swatch'), icon(iconName), el('span', label, 'tier-name'), el('b'));
                legend.appendChild(key);
            });
        }

        const counts = tierCounts(STAGES.flatMap(([ id ]) => queues[id] ?? []));

        TIERS.forEach(([ tier ]) => setText(
            legend.querySelector(`[data-tier="${tier}"] b`) as Element, String(counts[tier])));
    }

    /**
     * Draws each station as a team in a slim strip: a dot for each of its staff, how many are free and busy, and
     * behind that who they are, each busy one with the patient they are with.
     *
     * @param {Object[]} teams - The teams.
     * @returns {void}
     */
    function drawTeams(teams: ITeam[]): void {
        // The wait legend shares the strip's row, and stays when there is no station.
        $('teams-label').hidden = !teams.length;
        arrange($('team-list'), teams.map(team => {
            const node = kept(teamNodes, team.id, () => createTeam(team.id));

            updateTeam(node, team);

            return node;
        }));
    }

    /**
     * Makes a station's team: its counts, which open the names.
     *
     * @param {string} station - The station's id.
     * @returns {HTMLDetailsElement}
     */
    function createTeam(station: string): HTMLDetailsElement {
        const node = el('details', undefined, 'team');
        const summary = el('summary');

        node.dataset.station = station;
        summary.append(el('b', station), el('span', undefined, 'team-dots'), el('span', undefined, 'team-free'),
            el('span', undefined, 'team-busy'));
        node.append(summary, el('div', undefined, 'team-pop'));

        return node;
    }

    /**
     * Brings a station's team up to date.
     *
     * @param {HTMLDetailsElement} node - The team's element.
     * @param {Object} team - The team.
     * @returns {void}
     */
    function updateTeam(node: HTMLDetailsElement, team: ITeam): void {
        const pop = node.querySelector('.team-pop') as HTMLElement;
        const stage = stageNames(team.stages);

        setText(node.querySelector('.team-free') as Element, `ว่าง ${team.free.length}`);
        setText(node.querySelector('.team-busy') as Element, `ไม่ว่าง ${team.busy.length}`);
        (node.querySelector('summary') as HTMLElement).title = stage;

        const dots = node.querySelector('.team-dots') as HTMLElement;

        if (changed(dots, [ team.free, team.busy ])) {
            const dot = (state: 'busy' | 'free', m: ITeamMember, doing: string) => {
                const mark = el('i', undefined, 'team-dot');

                mark.dataset.state = state;
                mark.title = `${m.name || 'ไม่ระบุชื่อ'}: ${doing}`;

                return mark;
            };

            dots.textContent = '';
            dots.append(...team.free.map(m => dot('free', m, 'ว่าง')),
                ...team.busy.map(m => dot('busy', m, `กับ ${m.hn}`)));
        }
        if (!changed(pop, [ stage, team.free, team.busy ])) {
            return;
        }

        const member = (m: ITeamMember, hn?: string) => {
            const line = el('div', undefined, 'team-member');
            const who = m.name || 'ไม่ระบุชื่อ';

            line.dataset.state = hn === undefined ? 'free' : 'busy';
            line.append(el('span', initials(who), 'avatar'), el('span', who, 'person-name'),
                el('span', hn === undefined ? 'ว่าง' : `กับ ${hn}`, 'team-with'));

            return line;
        };

        pop.textContent = '';
        pop.appendChild(el('div', `ขั้น: ${stage}`, 'team-stage'));
        team.free.forEach(m => pop.appendChild(member(m)));
        team.busy.forEach(m => pop.appendChild(member(m, m.hn)));
    }

    /**
     * Draws the board: a column for each stage, in the pathway's order, with a card for each of its patients. A stage
     * with nobody collapses to a narrow strip.
     *
     * @param {Object} queues - The queues by stage.
     * @param {Object} examination - Examination's queue split by doctor.
     * @param {Object[]} teams - The stations' teams.
     * @param {Object[]} rooms - The rooms now.
     * @returns {void}
     */
    function drawQueues(queues: Record<string, IQueueEntry[]>, examination: IExamination, teams: ITeam[],
            rooms: IRoom[]): void {
        const list = $('queue-list');
        const focused = document.activeElement as HTMLElement | null;
        const drawn = new Set<string>();

        arrange(list, STAGES.map(([ id, name, iconName ], index) => {
            const column = kept(columnNodes, id, () => createColumn(id, name, iconName));
            const entries = queues[id] ?? [];
            const body = column.querySelector('.col-body') as HTMLElement;
            const card = (entry: IQueueEntry, position: number, noDoctor = false) => {
                const key = `${id}|${entry.encounterId}`;
                const ticket = kept(ticketNodes, key, () => createTicket(entry, id));

                drawn.add(key);
                updateTicket(ticket, entry, position, index, noDoctor);

                return ticket;
            };

            column.classList.toggle('collapsed', !entries.length);
            column.title = entries.length ? '' : `${name}: ไม่มีผู้ป่วย`;
            setText(column.querySelector('.stage-name') as Element, name);
            setText(column.querySelector('h3 .count') as Element, String(entries.length));
            updateColumnStats(column.querySelector('.col-stats') as HTMLElement, entries,
                teams.filter(team => team.stages.includes(id)), rooms);
            if (id === 'examination') {
                drawExamination(column, body, examination, card);
            } else {
                arrange(body, entries.map((entry, position) => card(entry, position)));
            }

            return column;
        }));
        list.style.gridTemplateColumns = STAGES
            .map(([ id ]) => queues[id]?.length ? 'minmax(14rem, 1fr)' : '2.8rem')
            .join(' ');
        ticketNodes.forEach((_, key) => drawn.has(key) || ticketNodes.delete(key));

        // A card that changed its place was taken out of the page for a moment, which takes the focus off it.
        if (focused?.isConnected && document.activeElement !== focused) {
            focused.focus({ preventScroll: true });
        }
    }

    /**
     * Makes a stage's column: its head, what the head says of its queue, and the body its cards go in.
     *
     * @param {string} id - The stage's id.
     * @param {string} name - Its name.
     * @param {string} iconName - Its icon.
     * @returns {HTMLElement}
     */
    function createColumn(id: string, name: string, iconName: string): HTMLElement {
        const column = el('div', undefined, 'queue');
        const title = el('h3');

        column.id = `queue-${id}`;
        column.dataset.stage = id;
        title.appendChild(el('span', undefined, 'tile')).appendChild(icon(iconName));
        title.append(el('span', name, 'stage-name'), el('span', undefined, 'count'));
        column.append(title, createColumnStats(), el('div', undefined, 'col-body'));
        if (id === 'examination') {
            // The doctors the doctor fields suggest.
            column.appendChild(el('datalist')).id = 'doctor-list';
        }

        return column;
    }

    /**
     * Draws examination's column split by doctor: a group for each doctor, then the patients with no doctor.
     *
     * @param {HTMLElement} column - The examination column.
     * @param {HTMLElement} body - Its body.
     * @param {Object} examination - Examination's queue split by doctor.
     * @param {Function} card - Draws an entry's card.
     * @returns {void}
     */
    function drawExamination(column: HTMLElement, body: HTMLElement, examination: IExamination,
            card: (entry: IQueueEntry, position: number, noDoctor?: boolean) => HTMLElement): void {
        const known = Object.keys(examination.doctors);
        const datalist = column.querySelector('datalist') as HTMLDataListElement;
        const groups: [string, string, IQueueEntry[]][] = known.map(
            doctor => [ doctor, `แพทย์ ${doctor}`, examination.doctors[doctor] ?? [] ]);

        if (changed(datalist, known)) {
            datalist.textContent = '';
            known.forEach(doctor => datalist.appendChild(el('option', doctor)).setAttribute('value', doctor));
        }
        groups.push([ '', 'ยังไม่กำหนดแพทย์', examination.unassigned ]);
        arrange(body, groups.filter(group => group[2].length).map(([ doctor, title, entries ]) => {
            const section = kept(groupNodes, doctor, () => {
                const node = el('div', undefined, 'doctor-group');
                const heading = el('h4');

                node.dataset.doctor = doctor;
                heading.append(el('span', title), el('span', undefined, 'count'));
                node.append(heading, el('div', undefined, 'group-body'));

                return node;
            });

            setText(section.querySelector('h4 .count') as Element, String(entries.length));
            arrange(section.querySelector('.group-body') as Element,
                entries.map((entry, position) => card(entry, position, !doctor)));

            return section;
        }));
    }

    /**
     * Makes an encounter's card: its face, with the position, HN, wait, badges and the action that sends the patient
     * on; and right after the face, the other things that can be done with the encounter, folded away.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage the encounter is in.
     * @returns {HTMLElement}
     */
    function createTicket(entry: IQueueEntry, stage: string): HTMLElement {
        const ticket = el('div', undefined, 'ticket');
        const face = el('div', undefined, 'queue-entry');
        const line = el('div', undefined, 'card-line');
        const hn = button(entry.hn || '—', 'hn-link');
        const wait = el('span', undefined, 'wait');
        const go = el('button', undefined, 'card-go primary');

        face.dataset.encounter = entry.encounterId;
        hn.title = 'ดูห้องของผู้ป่วย';
        hn.addEventListener('click', () => revealRoom(entry.hn || ''));
        wait.append(icon('clock'), el('span'));
        go.type = 'button';
        go.appendChild(icon('arrow'));
        go.addEventListener('click', event => {
            // The second click of a double click would send on whichever card has moved under the pointer.
            if (event.detail < 2) {
                changeStage(entry, go.dataset.to ?? '', go);
            }
        });
        const end = el('span', undefined, 'card-end');

        end.append(wait, go);
        line.append(el('span', undefined, 'position'), hn, end);
        face.append(line, el('div', undefined, 'card-badges'));

        const more = el('details', undefined, 'card-more');
        const controls = el('div', undefined, 'controls');
        const pick = el('select', undefined, 'stage-to');
        const send = button('ส่งไปขั้นที่เลือก', 'stage-go secondary', 'arrow');
        const done = button('เสร็จสิ้น', 'stage-done secondary', 'check');
        const video = button('', 'video-toggle secondary', 'play');

        more.appendChild(el('summary', 'ตัวเลือกเพิ่มเติม'));
        pick.setAttribute('aria-label', `ส่ง ${entry.hn || ''} ไปขั้น`);
        send.addEventListener('click', () => changeStage(entry, pick.value, send));
        done.addEventListener('click', () => changeStage(entry, 'done', done));
        video.addEventListener('click', () => toggleVideo(entry, PLAYING_VIDEOS.has(entry.encounterId), video));
        controls.append(pick, send, done, video);
        more.append(controls, createVideoChoice(entry, stage));
        if (stage === 'examination') {
            more.appendChild(createDoctorControl(entry));
        }
        more.appendChild(createQuestionnaires(entry));
        ticket.append(face, more);

        return ticket;
    }

    /**
     * Brings a card up to date.
     *
     * @param {HTMLElement} ticket - The card.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {number} position - Its place in the queue.
     * @param {number} index - The stage's place in the stages.
     * @param {boolean} noDoctor - Whether it is in examination with no doctor.
     * @returns {void}
     */
    function updateTicket(ticket: HTMLElement, entry: IQueueEntry, position: number, index: number,
            noDoctor: boolean): void {
        const find = <T extends Element = HTMLElement>(selector: string) => ticket.querySelector(selector) as unknown as T;
        const face = find('.queue-entry');
        const wait = find('.wait');
        const nhso = NHSO_STATUSES[entry.encounterId];
        const seconds = entry.waitedSeconds;

        const tier = tierOf(seconds);

        ticket.dataset.tier = tier === 'ok' ? '' : tier;

        // A card in trouble wears the same red bar as one that has waited too long.
        ticket.dataset.trouble = String(noDoctor || nhso === 'unavailable');
        face.classList.toggle('suggested', Boolean(entry.suggested));

        // Staff of a station are with the patient: they are at that station, whatever their stage's queue says.
        face.classList.toggle('at-station', Boolean(entry.at?.length));
        setText(find('.position'), String(position + 1));
        setText(wait.lastElementChild as Element, waited(seconds));
        wait.title = `รอมาแล้ว ${waitedInWords(seconds)}`;

        const next = STAGES[index + 1];
        const go = find<HTMLButtonElement>('.card-go');
        const who = entry.hn || 'ผู้ป่วย';

        go.dataset.to = next?.[0] ?? 'done';
        go.title = next ? `ส่งต่อไป ${next[1]}` : 'เสร็จสิ้น';
        go.setAttribute('aria-label', next ? `ส่ง ${who} ไป ${next[1]}` : `${who} เสร็จสิ้น`);
        go.querySelector('use')?.setAttribute('href', next ? '#i-arrow' : '#i-check');
        drawBadges(find('.card-badges'), entry, nhso);

        const pick = find<HTMLSelectElement>('.stage-to');
        const first = !pick.options.length;

        offer(pick, STAGES.filter(s => s[0] !== STAGES[index][0]).map(s => [ s[0], s[1] ]));
        if (first) {
            pick.value = nextStage(index);
        }

        const playing = PLAYING_VIDEOS.has(entry.encounterId);
        const video = find<HTMLButtonElement>('.video-toggle');

        setText(video.lastElementChild as Element, playing ? 'หยุดวิดีโอ' : 'เล่นวิดีโอ');
        video.querySelector('use')?.setAttribute('href', playing ? '#i-x' : '#i-play');
        find('.video-controls').hidden = !VIDEO_CATALOGUE.length;
        offer(find<HTMLSelectElement>('.video-pick'), VIDEO_CATALOGUE.map(v => [ v.id, v.title ]));
        updateQuestionnaires(find('.questionnaires'), entry);
    }

    /**
     * Draws a card's badges, each with an icon and words: what else there is to know about the patient.
     *
     * @param {HTMLElement} row - Where they go.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string|undefined} nhso - Its NHSO authentication, if it has one.
     * @returns {void}
     */
    function drawBadges(row: HTMLElement, entry: IQueueEntry, nhso?: NhsoStatus): void {
        const badges: { hint?: string; icon: string; kind: string; text: string; }[] = [];

        if (entry.suggested) {
            badges.push({ icon: 'arrow', kind: 'next', text: 'ถัดไป' });
        }
        if (entry.at?.length) {
            badges.push({ icon: 'users', kind: 'at', text: `อยู่ที่ ${entry.at.join(', ')}` });
        }

        // An authenticated patient is the ordinary case, and says nothing.
        if (nhso && nhso !== 'authenticated') {
            const [ text, hint ] = NHSO_LABELS[nhso];

            badges.push({ hint, icon: 'key', kind: `nhso nhso-${nhso}`, text });
        }
        if (PLAYING_VIDEOS.has(entry.encounterId)) {
            badges.push({ icon: 'play', kind: 'video', text: 'กำลังเล่นวิดีโอ' });
        }
        if (!changed(row, badges)) {
            return;
        }
        row.textContent = '';
        badges.forEach(b => {
            const badge = el('span', undefined, `badge ${b.kind}`);

            badge.title = b.hint ?? '';
            badge.append(icon(b.icon), el('span', b.text));
            row.appendChild(badge);
        });
    }

    /**
     * Makes the control that changes an encounter's doctor.
     *
     * @param {Object} entry - The encounter's entry in the examination queue.
     * @returns {HTMLElement}
     */
    function createDoctorControl(entry: IQueueEntry): HTMLElement {
        const input = el('input', undefined, 'doctor-to');
        const set = button('กำหนดแพทย์', 'doctor-set secondary');
        const wrap = el('div', undefined, 'controls doctor-controls');

        input.setAttribute('list', 'doctor-list');
        input.setAttribute('aria-label', `แพทย์ของ ${entry.hn || 'ผู้ป่วย'}`);
        input.placeholder = 'รหัสแพทย์';
        set.addEventListener('click', () => {
            const doctor = input.value.trim();

            input.value = '';
            setDoctor(entry, doctor || null, set);
        });
        wrap.append(input, set);

        return wrap;
    }

    /**
     * Makes the place for an encounter's health questionnaires: a list to send one from, and what was sent.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {HTMLElement}
     */
    function createQuestionnaires(entry: IQueueEntry): HTMLElement {
        const box = el('div', undefined, 'questionnaires');
        const controls = el('div', undefined, 'controls');
        const pick = el('select', undefined, 'questionnaire-pick');
        const send = button('ส่งแบบสอบถาม', 'questionnaire-send secondary', 'clipboard');

        pick.setAttribute('aria-label', `แบบสอบถามที่จะส่งให้ ${entry.hn || ''}`);
        send.addEventListener('click', () => sendQuestionnaire(entry, pick.value, send));
        controls.append(pick, send);
        box.append(controls, el('div', undefined, 'questionnaire-sent'));

        return box;
    }

    /**
     * Draws the health questionnaires of an encounter: those that can be sent, and those sent, with the answers.
     *
     * @param {HTMLElement} box - Their place on the card.
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {void}
     */
    function updateQuestionnaires(box: HTMLElement, entry: IQueueEntry): void {
        const sent = questionnaires.sent[entry.encounterId] ?? [];
        const list = box.querySelector('.questionnaire-sent') as HTMLElement;

        box.hidden = !questionnaires.catalogue.length && !sent.length;
        (box.querySelector('.controls') as HTMLElement).hidden = !questionnaires.catalogue.length;
        offer(box.querySelector('.questionnaire-pick') as HTMLSelectElement,
            questionnaires.catalogue.map(q => [ q.id, q.title ]));
        if (!changed(list, sent)) {
            return;
        }
        list.textContent = '';
        for (const q of sent) {
            const item = el('div', undefined, 'questionnaire');
            const state = q.answers ? 'ตอบแล้ว' : q.closedAt ? 'ปิดแล้ว (เจ้าหน้าที่เข้าห้อง)' : 'รอคำตอบ';

            item.appendChild(el('strong', `${q.title} · ${state}`));
            q.answers?.forEach((answer, i) => {
                item.appendChild(el('div', `${q.questions[i].text} — ${q.questions[i].choices[answer]}`, 'answer'));
            });
            list.appendChild(item);
        }
    }

    /**
     * Sends a health questionnaire to a patient.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} questionnaire - The questionnaire's id.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function sendQuestionnaire(entry: IQueueEntry, questionnaire: string, trigger: HTMLButtonElement): void {
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/questionnaires`;

        hold(trigger, act(path, { questionnaire }), result => {
            if (result.status === 409) {
                say('encounter นี้เสร็จสิ้นแล้ว', 'warn');
            } else if (failed(result)) {
                say('ส่งแบบสอบถามไม่สำเร็จ', 'error');
            } else {
                say(`ส่งแบบสอบถามให้ ${entry.hn || 'ผู้ป่วย'} แล้ว`, 'ok');
            }
        });
    }

    /**
     * Shows one of the page's two views: the queue, or the rooms and their moves.
     *
     * @param {string} view - Which: queue or rooms.
     * @returns {void}
     */
    function showView(view: string): void {
        document.querySelectorAll<HTMLElement>('#views button').forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.view === view));
        });
        $('view-queue').hidden = view !== 'queue';
        $('view-rooms').hidden = view !== 'rooms';
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
        showView('rooms');
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
            const stage = stageNames(room.stages ?? []);

            return stage ? `ห้องพักเจ้าหน้าที่: ${stage}` : 'ห้องพักเจ้าหน้าที่';
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
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/stage`;

        hold(trigger, act(path, { stage }), result => {
            if (result.status === 409) {
                say('encounter นี้เสร็จสิ้นแล้ว', 'warn');
            } else if (failed(result)) {
                say('เปลี่ยนขั้นไม่สำเร็จ', 'error');
            } else if (stage === 'done') {
                say(`${hn} เสร็จสิ้นแล้ว`, 'ok');
            } else {
                say(`ส่ง ${hn} ไปขั้น “${STAGES.find(s => s[0] === stage)?.[1] ?? stage}” แล้ว`, 'ok');
            }
        });
    }

    /**
     * Plays the waiting video of a patient's stage in their room, or stops the one that plays.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {boolean} playing - Whether a video plays now, so that the click stops it.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function toggleVideo(entry: IQueueEntry, playing: boolean, trigger: HTMLButtonElement): void {
        const hn = entry.hn || 'ผู้ป่วย';
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/video${playing ? '/stop' : ''}`;

        hold(trigger, act(path, {}), result => {
            if (failed(result)) {
                say(playing ? 'หยุดวิดีโอไม่สำเร็จ' : 'เล่นวิดีโอไม่ได้ ขั้นนี้อาจไม่มีวิดีโอ หรือระบบเล่นวิดีโอไม่พร้อม', 'error');
            } else {
                say(playing ? `หยุดวิดีโอของ ${hn} แล้ว` : `เริ่มเล่นวิดีโอให้ ${hn} แล้ว`, 'ok');
            }
        });
    }

    /**
     * Makes the control that chooses the waiting video a patient gets at their current stage.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage the encounter is in.
     * @returns {HTMLElement}
     */
    function createVideoChoice(entry: IQueueEntry, stage: string): HTMLElement {
        const pick = el('select', undefined, 'video-pick');
        const set = button('เลือกวิดีโอ', 'video-choose secondary');
        const wrap = el('div', undefined, 'controls video-controls');
        const hn = entry.hn || 'ผู้ป่วย';
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/video-choice`;

        pick.setAttribute('aria-label', `วิดีโอของ ${hn}`);
        set.addEventListener('click', () => {
            hold(set, act(path, { stage,
                video: pick.value }), result => {
                say(failed(result) ? 'เลือกวิดีโอไม่สำเร็จ' : `เลือกวิดีโอของ ${hn} แล้ว`, failed(result) ? 'error' : 'ok');
            });
        });
        wrap.append(pick, set);

        return wrap;
    }

    /**
     * Sets, changes or takes away an encounter's doctor.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string|null} doctor - The doctor's identity id; null takes the doctor away.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function setDoctor(entry: IQueueEntry, doctor: string | null, trigger: HTMLButtonElement): void {
        const hn = entry.hn || 'ผู้ป่วย';
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/doctor`;

        hold(trigger, act(path, { doctor }), result => {
            if (result.status === 409) {
                say('encounter นี้เสร็จสิ้นแล้ว', 'warn');
            } else if (failed(result)) {
                say('เปลี่ยนแพทย์ไม่สำเร็จ', 'error');
            } else {
                say(doctor ? `กำหนดแพทย์ ${doctor} ให้ ${hn} แล้ว` : `ยกเลิกแพทย์ของ ${hn} แล้ว`, 'ok');
            }
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
        if (unstarted && room.appointment) {
            const badge = el('span', APPOINTMENT_BADGES[room.appointment][0], 'badge warn appointment');

            badge.title = APPOINTMENT_BADGES[room.appointment][1];
            badges.appendChild(badge);
        }
        if (people.length !== room.occupants.length) {
            badges.appendChild(el('span', 'กำลังบันทึก', 'badge rec'));
        }
        if (room.unrecorded) {
            const badge = el('span', 'ไม่ได้บันทึก', 'badge warn');

            badge.title = 'ผู้บันทึกของห้องนี้หยุดทำงาน และไม่มีผู้บันทึกอื่นว่าง';
            badges.appendChild(badge);
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

            badge.title = 'ผู้ถูกย้ายเห็นการนับถอยหลังอยู่';
            line.appendChild(badge);
        } else if (o.role === 'staff') {
            // Patients stay in their own room (ADR 0011): only staff are moved.
            line.appendChild(moveControls(o, room, rooms));
        }

        return line;
    }

    /**
     * Draws the controls that move a staff member: the rooms they may go to, and a field for a room by its HN.
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

        // A patient's room that is in no list can be named by its HN; the service refuses it while it is closed.
        const typed = el('input', undefined, 'move-hn');
        const destination = () => typed.value.trim() || pick.value;
        const update = () => {
            go.disabled = !destination();
        };

        pick.setAttribute('aria-label', `ย้าย ${names[o.endpointId]} ไปห้อง`);
        addDestinations(pick, room, rooms);
        pick.value = choices[key] || '';
        pick.addEventListener('change', () => {
            choices[key] = pick.value;
            update();
        });
        controls.appendChild(pick);
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
     * Lists the rooms a staff member may be moved to, grouped by kind: the open patients' rooms, and the lounges, open
     * or not (ADR 0011).
     *
     * @param {HTMLSelectElement} pick - The list.
     * @param {Object} o - The occupant.
     * @param {Object} room - Their room, which is not offered.
     * @param {Object[]} rooms - Every room.
     * @returns {void}
     */
    function addDestinations(pick: HTMLSelectElement, room: IRoom, rooms: IRoom[]): void {
        const blank = el('option', 'ย้ายไปห้อง…');

        blank.value = '';
        pick.appendChild(blank);
        [ 'patient', 'lounge' ].forEach(kind => {
            const group = el('optgroup');

            group.label = KINDS.find(k => k[0] === kind)?.[1] ?? kind;
            rooms.filter(other => other.kind === kind && other.name !== room.name)
                .forEach(other => {
                    const notes = [ other.kind === 'lounge' ? stageNames(other.stages ?? []) : '' ].filter(Boolean);
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

    /** Today's NHSO bypass day, as the last refresh found it. */
    let bypass: IBypassDay | null = null;

    /**
     * Draws the NHSO chip and its control: today's bypass day and who declared it, with the button that declares or
     * cancels it.
     *
     * @param {Object|null} day - Today's bypass day, if there is one.
     * @returns {void}
     */
    function drawNhso(day: IBypassDay | null): void {
        bypass = day;
        $('nhso-chip').dataset.bypass = String(Boolean(day));
        $('nhso-state').textContent = day ? 'วันนี้ bypass สปสช.' : 'สปสช. ปกติ';
        $('nhso-text').textContent = day
            ? `วันนี้ bypass สปสช. (API ล่ม) ประกาศโดย ${day.declaredBy} เวลา ${clockTime(day.declaredAt)} ถึงเที่ยงคืน`
            : 'ยืนยันตัวตน สปสช.: ถ้า API ของ สปสช. ล่มทั้งวัน ให้ประกาศ bypass วันนี้';
        $('nhso-toggle').textContent = day ? 'ยกเลิก bypass' : 'ประกาศ bypass วันนี้';
    }

    /**
     * Opens or closes the control behind the NHSO chip.
     *
     * @param {boolean} open - Whether it is to be seen.
     * @returns {void}
     */
    function showNhsoControl(open: boolean): void {
        $('nhso-pop').hidden = !open;
        $('nhso-chip').setAttribute('aria-expanded', String(open));
    }

    /**
     * Formats a time of day, as the coordinator's clock shows it.
     *
     * @param {string} at - An ISO time.
     * @returns {string}
     */
    function clockTime(at: string): string {
        return new Date(at).toLocaleTimeString('th-TH', { hour: '2-digit', minute: '2-digit' });
    }

    $('nhso-chip').addEventListener('click', () => showNhsoControl(Boolean($('nhso-pop').hidden)));

    /**
     * Closes the names of the teams, but for the team that holds an element.
     *
     * @param {Node} [keep] - The element.
     * @returns {void}
     */
    function closeTeams(keep?: Node): void {
        teamNodes.forEach(team => {
            if (!keep || !team.contains(keep)) {
                team.open = false;
            }
        });
    }

    // A click elsewhere, or Escape, closes the NHSO control and a team's names.
    document.addEventListener('click', event => {
        closeTeams(event.target as Node);
        if (!(event.target as Element).closest('.nhso')) {
            showNhsoControl(false);
        }
    });
    document.addEventListener('keydown', event => {
        if (event.key !== 'Escape') {
            return;
        }
        closeTeams();
        if (!$('nhso-pop').hidden) {
            showNhsoControl(false);
            $('nhso-chip').focus();
        }
    });
    $('nhso-toggle').addEventListener('click', () => {
        const cancel = Boolean(bypass);
        const sure = cancel
            ? 'ยกเลิก bypass ของวันนี้? การยกเลิกจะถูกบันทึกใน audit log'
            : 'ประกาศว่า API ของ สปสช. ล่มทั้งวันนี้? ทุก encounter ของวันนี้จะถูกนับเป็น bypass จนถึงเที่ยงคืน และบันทึกใน audit log ว่าใครประกาศ';

        if (!window.confirm(sure)) {
            return;
        }
        showNhsoControl(false);
        $<HTMLButtonElement>('nhso-toggle').disabled = true;
        act(cancel ? '/nhso/bypass/cancel' : '/nhso/bypass', {}).then(result => {
            $<HTMLButtonElement>('nhso-toggle').disabled = false;
            if (failed(result)) {
                say(cancel ? 'ยกเลิก bypass ไม่สำเร็จ' : 'ประกาศ bypass ไม่สำเร็จ', 'error');
            } else {
                say(cancel ? 'ยกเลิก bypass ของวันนี้แล้ว' : 'ประกาศ bypass ของวันนี้แล้ว', 'ok');
            }
            refresh();
        });
    });

    /**
     * Reads the state from the service and draws it.
     *
     * @returns {Promise<void>} Resolved once it is drawn, or could not be read.
     */
    function refresh(): Promise<void> {
        const token = sessionStorage.getItem(TOKEN_KEY);

        if (!token) {
            showSignIn();

            return Promise.resolve();
        }

        return fetch('screen/api/state', { headers: { Authorization: `Bearer ${token}` } })
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
                    $('head').hidden = false;
                    $('who-name').textContent = who;
                    $('who-avatar').textContent = initials(who);
                    $('problem').hidden = true;
                    showLive(true);
                    useStages(state.stages);
                    questionnaires = state.questionnaires ?? { catalogue: [],
                        sent: {} };
                    drawStats(state);
                    PLAYING_VIDEOS = new Set((state.videos ?? []).map(v => v.encounterId));
                    NHSO_STATUSES = state.nhso?.statuses ?? {};
                    drawNhso(state.nhso?.bypass ?? null);
                    VIDEO_CATALOGUE = state.videoCatalogue ?? [];

                    drawTeams(state.teams);
                    drawLegend(state.queues);
                    drawQueues(state.queues, state.examination, state.teams, state.rooms);

                    // The rooms are drawn anew: a list being chosen from would close, and a field being typed in would
                    // lose its place.
                    if (!($('rooms').contains(document.activeElement)
                            && document.activeElement?.matches('select, input.move-hn'))) {
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
    document.querySelectorAll<HTMLElement>('#views button').forEach(b => {
        b.addEventListener('click', () => showView(b.dataset.view ?? 'queue'));
    });
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
