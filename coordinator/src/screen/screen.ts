/*
 * The coordinator screen. It shows the queues and the open rooms, and refreshes every few seconds. Everything it shows
 * is put in the page as text, never as markup: names come from the participants' tokens.
 */
(function() {
    const TOKEN_KEY = 'coordinator-token';

    /** Where the tab keeps the clinic its coordinator follows. */
    const CLINIC_KEY = 'coordinator-clinic';
    const REFRESH_MS = 2000;

    /** How long a wait is before it is shown as long, and as too long. */
    const WAIT_WARN_SECONDS = 5 * 60;
    const WAIT_LONG_SECONDS = 15 * 60;

    /** How long an encounter has been open before its card says how long it has been in the system. */
    const LONG_TOTAL_SECONDS = 90 * 60;

    /** How long a move has run before it is shown as stuck. */
    const MOVE_STUCK_SECONDS = 60;

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

    /** The video playing for each encounter a waiting video is playing for now. */
    let PLAYING_VIDEOS = new Map<string, string>();

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

    /** The service's time at the last refresh: the desk's clock may be wrong. */
    let SERVICE_NOW = Date.now();

    /** The center's clinics' names, by id, as the last refresh found them. */
    let CLINIC_NAMES: Record<string, string> = {};

    /** The clinic the board shows the patients of now; none while it shows all. */
    let CLINIC_SHOWN = '';

    /** The clinic the coordinator follows, in this tab only; none while all are shown. */
    let clinicPick = sessionStorage.getItem(CLINIC_KEY) ?? '';

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

        /** The encounter's clinic, if it has one. */
        clinic?: string;
        /** The encounter's doctor, if it has one: a staff member's identity id. */
        doctor?: string;
        encounterId: string;

        /** Every stage the encounter has entered, in order, with when it did. */
        history: { at: string; stage: string; }[];
        hn?: string;

        /** The stages of the encounter's pathway, in order, from `waiting` to `done`. */
        pathwayStages: string[];

        /** When the encounter started. */
        startedAt: string;
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
        questionnaire: string;
        questions: { choices: string[]; text: string; }[];
        title: string;
    }

    interface IQuestionnaires {
        catalogue: { id: string; title: string; }[];
        sent: Record<string, ISentQuestionnaire[]>;
    }

    interface IClinic {
        id: string;
        name: string;
    }

    interface IState {
        clinics: IClinic[];
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
        videos?: { encounterId: string; video: string; }[];
    }

    /** How the day is going, as the service counts it. */
    interface ITodayFigures {
        averageSeconds?: number;
        done: number;
        hours: { done: number; hour: number; started: number; }[];
        longest?: { seconds: number; since: string; stage: string; };
        stages: { averageSeconds?: number; id: string; }[];
        started: number;
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
     * open team names, a half-typed field, a picked stage and the focus survive it. A card, and the open panel, is one
     * element for as long as its encounter stays in one stage.
     */
    const teamNodes = new Map<string, HTMLDetailsElement>();
    const columnNodes = new Map<string, HTMLElement>();
    const groupNodes = new Map<string, HTMLElement>();
    const ticketNodes = new Map<string, HTMLElement>();
    const clinicNodes = new Map<string, HTMLButtonElement>();

    /** The state the last refresh read, which picking a clinic draws the board from again. */
    let latest: IState | undefined;

    /** The encounter whose panel is open, if one is. */
    let selected: string | undefined;

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
     * Tells how long an encounter has been open.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {number} Seconds.
     */
    function secondsInSystem(entry: IQueueEntry): number {
        return Math.max(0, Math.floor((SERVICE_NOW - Date.parse(entry.startedAt)) / 1000));
    }

    /**
     * Tells how long an encounter spent in a stage it has left, over every time it was there.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage.
     * @returns {number|undefined} Seconds; nothing for a stage it has never left.
     */
    function secondsSpent(entry: IQueueEntry, stage: string): number | undefined {
        // A stretch ends where the next one starts: the last one is still open.
        const stretches = entry.history.slice(0, -1).flatMap((entered, i) => entered.stage === stage
            ? [ (Date.parse(entry.history[i + 1].at) - Date.parse(entered.at)) / 1000 ]
            : []);

        return stretches.length ? Math.floor(stretches.reduce((sum, one) => sum + one, 0)) : undefined;
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
        closeDetail(false);
        sessionStorage.removeItem(TOKEN_KEY);
        say();
        $('signin').hidden = false;
        $('board').hidden = true;
        $('head').hidden = true;
        showNhsoControl(false);
        showView('queue');
        showToday(false);
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
     * Draws the header's figure of the moves under way: how many, how many of them are stuck, and as its hint each
     * move with who, from where, to where and for how long.
     *
     * @param {Object[]} moves - The moves under way and recent.
     * @param {number} now - The service's time, which the moves' starts are told in.
     * @returns {void}
     */
    function drawMoves(moves: IMove[], now: number): void {
        const underWay = moves.filter(isUnderWay).map(m => {
            return { move: m,
                seconds: Math.max(0, Math.floor((now - Date.parse(m.startedAt)) / 1000)) };
        });
        const stuck = underWay.filter(m => m.seconds >= MOVE_STUCK_SECONDS).length;
        const figure = $('stat-moves');
        const mark = figure.querySelector('.stat-stuck') as HTMLElement;

        setText($('stat-moving'), String(underWay.length));
        figure.dataset.stuck = String(stuck > 0);
        mark.hidden = !stuck;
        setText(mark.lastElementChild as Element, `ค้าง ${stuck}`);
        figure.title = underWay.map(({ move: m, seconds }) => `${names[m.endpointId] || 'ผู้เข้าร่วม'}: ${m.origin} → ${
            m.destination || '?'} (${waitedInWords(seconds)})`).join('\n') || 'ไม่มีการย้ายที่กำลังดำเนินอยู่';
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
     * Draws the clinic filter, and below it the board with the patients of the clinic picked, or of every clinic. The
     * header's figures and everything else stay the center's.
     *
     * @param {Object} state - The state.
     * @returns {void}
     */
    function drawBoard(state: IState): void {
        CLINIC_NAMES = Object.fromEntries(state.clinics.map(c => [ c.id, c.name ]));

        // A clinic kept from before that the center no longer has shows all of them.
        CLINIC_SHOWN = state.clinics.some(c => c.id === clinicPick) ? clinicPick : '';
        drawClinicFilter(state);

        const shown = (entries: IQueueEntry[]) =>
            CLINIC_SHOWN ? entries.filter(e => e.clinic === CLINIC_SHOWN) : entries;
        const eachShown = (lists: Record<string, IQueueEntry[]>) =>
            Object.fromEntries(Object.entries(lists).map(([ key, entries ]) => [ key, shown(entries) ]));

        drawQueues(eachShown(state.queues), {
            doctors: eachShown(state.examination.doctors),
            unassigned: shown(state.examination.unassigned)
        }, state.teams, state.rooms);
    }

    /**
     * Draws the choice of all clinics and each of the center's clinics, each with how many patients it has. A center
     * with no clinics has nothing to choose.
     *
     * @param {Object} state - The state.
     * @returns {void}
     */
    function drawClinicFilter(state: IState): void {
        const entries = Object.values(state.queues).flat();

        $('clinic-filter').hidden = !state.clinics.length;
        $('clinic-filter').previousElementSibling?.toggleAttribute('hidden', !state.clinics.length);
        arrange($('clinic-filter'), [ { id: '', name: 'ทุกคลินิก' }, ...state.clinics ].map(({ id, name }) => {
            const choice = kept(clinicNodes, id, () => {
                const node = button('', '');

                node.dataset.clinic = id;
                node.addEventListener('click', () => pickClinic(id));

                return node;
            });

            setText(choice.firstElementChild as Element, name);
            choice.dataset.count = String(id ? entries.filter(e => e.clinic === id).length : entries.length);
            choice.setAttribute('aria-pressed', String(id === CLINIC_SHOWN));

            return choice;
        }));
    }

    /**
     * Follows a clinic, or all of them, and keeps that for this tab.
     *
     * @param {string} id - The clinic, or none for all.
     * @returns {void}
     */
    function pickClinic(id: string): void {
        clinicPick = id;
        sessionStorage.setItem(CLINIC_KEY, id);
        if (latest) {
            drawBoard(latest);
            loadToday();
        }
    }

    /**
     * Opens or closes today's figures.
     *
     * @param {boolean} open - Whether they are shown.
     * @returns {void}
     */
    function showToday(open: boolean): void {
        $('today').hidden = !open;
        $('today-toggle').setAttribute('aria-expanded', String(open));
    }

    /**
     * Reads today's figures of the clinic followed and draws them. Figures that cannot be read leave the last ones: the
     * state's refresh tells of a service that cannot be reached.
     *
     * @returns {void}
     */
    function loadToday(): void {
        const token = sessionStorage.getItem(TOKEN_KEY);
        const clinic = CLINIC_SHOWN;

        fetch(`screen/api/today?clinic=${encodeURIComponent(clinic)}`, { headers: { Authorization: `Bearer ${token}` } })
            .then(response => response.ok ? response.json() : undefined)
            .then((figures?: ITodayFigures) => {
                // Another clinic may have been picked, or the coordinator signed out, while these were on their way.
                if (figures && clinic === CLINIC_SHOWN && sessionStorage.getItem(TOKEN_KEY) === token) {
                    $('today').dataset.clinic = clinic;
                    drawToday(figures);
                }
            })
            .catch(() => undefined);
    }

    /**
     * Describes how long something took, in hours and minutes.
     *
     * @param {number} seconds - How long.
     * @returns {string}
     */
    function duration(seconds: number): string {
        const minutes = Math.floor(seconds / 60);

        return minutes < 60 ? `${minutes} นาที` : `${Math.floor(minutes / 60)} ชม. ${minutes % 60} นาที`;
    }

    /**
     * Fills one of today's tiles.
     *
     * @param {string} id - The tile.
     * @param {string} value - Its figure.
     * @param {string} note - What the figure is of.
     * @returns {void}
     */
    function drawTile(id: string, value: string, note: string): void {
        setText($(id).querySelector('strong') as Element, value);
        setText($(id).querySelector('.today-note') as Element, note);
    }

    /**
     * Draws today's figures, and today's completions on the button that opens them.
     *
     * @param {Object} figures - The figures.
     * @returns {void}
     */
    function drawToday(figures: ITodayFigures): void {
        const { averageSeconds, done, longest, started } = figures;

        setText($('today-toggle-text'), `สถิติวันนี้ · เสร็จ ${done}`);
        drawTile('today-done', String(done), `จาก ${started} ราย ที่เข้ามา`);
        drawTile('today-average', averageSeconds === undefined ? '–' : duration(averageSeconds),
            averageSeconds === undefined ? 'ยังไม่มีรายที่เสร็จ' : 'ของที่เสร็จแล้ววันนี้');
        drawTile('today-longest', longest ? duration(longest.seconds) : '–', longest
            ? `${STAGE_NAMES[longest.stage] ?? longest.stage} ตั้งแต่ ${clockTime(longest.since)}`
            : 'ยังไม่มีการรอ');
        drawStageAverages(figures.stages);
        drawHours(figures.hours);
    }

    /**
     * Draws the average wait of each stage as a bar against the 15-minute limit.
     *
     * @param {Object[]} stages - The stages, in order.
     * @returns {void}
     */
    function drawStageAverages(stages: ITodayFigures['stages']): void {
        const titles = stages.map(s => STAGE_NAMES[s.id] ?? s.id);

        if (!changed($('today-stages'), [ stages, titles ])) {
            return;
        }

        // The scale leaves room past the limit, so that its line shows even when every stage is short.
        const max = Math.max(WAIT_LONG_SECONDS * 1.4, ...stages.map(s => s.averageSeconds ?? 0));

        $('today-stages').replaceChildren(...stages.map(({ averageSeconds }, i) => {
            const seconds = averageSeconds ?? 0;
            const minutes = averageSeconds === undefined ? '–' : (averageSeconds / 60).toFixed(1);
            const over = tierOf(seconds) === 'long';
            const row = el('div', undefined, 'hbar');
            const track = el('span', undefined, 'hbar-track');
            const fill = el('span', undefined, 'hbar-fill');
            const limit = el('span', undefined, 'hbar-limit');
            const value = el('span', undefined, 'hbar-value');

            row.dataset.stage = stages[i]?.id ?? '';
            row.dataset.tier = tierOf(seconds);
            row.title = averageSeconds === undefined
                ? `${titles[i]}: วันนี้ยังไม่มีรายที่ผ่านขั้นนี้`
                : `${titles[i]}: เฉลี่ย ${minutes} นาที${over ? ' (เกินเกณฑ์ 15 นาที)' : ''}`;
            fill.style.width = `${seconds * 100 / max}%`;
            limit.style.left = `${WAIT_LONG_SECONDS * 100 / max}%`;
            track.append(fill, limit);
            if (over) {
                value.appendChild(icon('alert'));
            }
            value.appendChild(el('span', minutes));
            row.append(el('span', titles[i], 'hbar-name'), track, value);

            return row;
        }));
    }

    /**
     * Draws the encounters started and done in each hour, side by side.
     *
     * @param {Object[]} hours - The hours, the one it is now last.
     * @returns {void}
     */
    function drawHours(hours: ITodayFigures['hours']): void {
        if (!changed($('today-hours'), hours)) {
            return;
        }

        const top = Math.max(1, ...hours.flatMap(h => [ h.started, h.done ]));

        $('today-hourly').dataset.wide = String(hours.length > 12);
        $('today-hours-none').hidden = hours.length > 0;
        $('today-hours').replaceChildren(...hours.map(({ done, hour, started }, i) => {
            const time = `${String(hour).padStart(2, '0')}:00`;
            const group = el('div', undefined, 'hour-group');
            const bars = el('div', undefined, 'hour-bars');
            const label = el('span', undefined, 'hour-label');
            const series: [string, number, string][] = [ [ 'in', started, 'เข้าใหม่' ], [ 'out', done, 'เสร็จ' ] ];

            series.forEach(([ key, count, name ]) => {
                const bar = el('span', undefined, `hour-bar ${key}`);

                bar.style.height = `${count * 100 / top}%`;
                bar.title = `${time}: ${name} ${count} ราย`;
                bar.appendChild(el('span', String(count), 'hour-value'));
                bars.appendChild(bar);
            });
            label.appendChild(el('span', time));
            if (i === hours.length - 1) {
                label.appendChild(el('span', 'ตอนนี้'));
            }
            group.append(bars, label);

            return group;
        }));

        // The latest hours are the ones to see.
        $('today-hours').scrollLeft = $('today-hours').scrollWidth;
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
                const ticket = kept(ticketNodes, key, () => createTicket(entry));

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
                drawExamination(body, examination, card);
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

        return column;
    }

    /**
     * Draws examination's column split by doctor: a group for each doctor, then the patients with no doctor.
     *
     * @param {HTMLElement} body - The examination column's body.
     * @param {Object} examination - Examination's queue split by doctor.
     * @param {Function} card - Draws an entry's card.
     * @returns {void}
     */
    function drawExamination(body: HTMLElement, examination: IExamination,
            card: (entry: IQueueEntry, position: number, noDoctor?: boolean) => HTMLElement): void {
        const groups: [string, string, IQueueEntry[]][] = Object.keys(examination.doctors).map(
            doctor => [ doctor, `แพทย์ ${doctor}`, examination.doctors[doctor] ?? [] ]);

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
     * Makes an encounter's card: the position, HN, wait, badges and the action that sends the patient on. A click
     * anywhere else on it opens the encounter's panel, as does a button the keyboard reaches.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {HTMLElement}
     */
    function createTicket(entry: IQueueEntry): HTMLElement {
        const ticket = el('div', undefined, 'ticket');
        const face = el('div', undefined, 'queue-entry');
        const line = el('div', undefined, 'card-line');
        const hn = button(entry.hn || '—', 'hn-link');
        const wait = el('span', undefined, 'wait');
        const go = el('button', undefined, 'card-go primary');
        const open = el('button', undefined, 'card-open');

        open.type = 'button';
        open.setAttribute('aria-haspopup', 'dialog');
        open.setAttribute('aria-label', `รายละเอียดของ ${entry.hn || 'ผู้ป่วย'}`);
        open.addEventListener('click', () => openDetail(entry.encounterId));
        ticket.addEventListener('click', event => {
            // A second click is the rest of a double click, which was meant for what was there before.
            if (event.detail < 2 && !(event.target as Element).closest('button')) {
                openDetail(entry.encounterId);
            }
        });
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
        face.append(open, line, el('div', undefined, 'card-badges'));
        ticket.appendChild(face);

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

        // The next stage of the encounter's own pathway, which may skip a column of the board.
        const to = entry.pathwayStages[entry.pathwayStages.indexOf(STAGES[index][0]) + 1] ?? 'done';
        const next = to === 'done' ? undefined : STAGE_NAMES[to] ?? to;
        const go = find<HTMLButtonElement>('.card-go');
        const who = entry.hn || 'ผู้ป่วย';

        go.dataset.to = to;
        go.title = next ? `ส่งต่อไป ${next}` : 'เสร็จสิ้น';
        go.setAttribute('aria-label', next ? `ส่ง ${who} ไป ${next}` : `${who} เสร็จสิ้น`);
        go.querySelector('use')?.setAttribute('href', next ? '#i-arrow' : '#i-check');
        drawBadges(find('.card-badges'), entry, nhso);
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

        // With one clinic picked, every card is that clinic's: the tag would say nothing.
        if (entry.clinic && !CLINIC_SHOWN) {
            badges.push({ hint: 'คลินิก', icon: 'clipboard', kind: 'clinic', text: CLINIC_NAMES[entry.clinic] ?? entry.clinic });
        }
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

        // A questionnaire closed without an answer can no longer be answered: it counts as neither.
        const asked = (questionnaires.sent[entry.encounterId] ?? []).filter(q => q.answers || !q.closedAt);
        const pending = asked.filter(q => !q.answers).length;

        if (pending) {
            badges.push({ icon: 'clipboard', kind: 'qwait', text: `รอคำตอบแบบสอบถาม ${pending}` });
        } else if (asked.length) {
            badges.push({ icon: 'clipboard', kind: 'qdone', text: 'ตอบแบบสอบถามแล้ว' });
        }

        const inSystem = secondsInSystem(entry);

        if (inSystem >= LONG_TOTAL_SECONDS) {
            badges.push({ icon: 'hourglass', kind: 'total', text: `อยู่ในระบบ ${duration(inSystem)}` });
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
     * Opens an encounter's panel over the board. What is behind it takes neither clicks nor the keyboard.
     *
     * @param {string} encounterId - The encounter.
     * @returns {void}
     */
    function openDetail(encounterId: string): void {
        selected = encounterId;
        $('detail').hidden = false;
        setBehindDetail(true);
        drawDetail();
        $('detail').querySelector<HTMLElement>('.sheet-close')?.focus();
    }

    /**
     * Closes the encounter's panel, if one is open.
     *
     * @param {boolean} [refocus] - Whether the focus goes back to the encounter's card.
     * @returns {void}
     */
    function closeDetail(refocus = true): void {
        if (selected === undefined) {
            return;
        }

        const encounterId = selected;

        selected = undefined;
        $('detail').hidden = true;
        $('detail').querySelector('.sheet')?.remove();
        setBehindDetail(false);
        ticketNodes.forEach((ticket, key) => {
            ticket.dataset.selected = 'false';
            if (refocus && key.endsWith(`|${encounterId}`)) {
                ticket.querySelector<HTMLElement>('.card-open')?.focus();
            }
        });
    }

    /**
     * Takes the page behind the panel out of reach, or gives it back.
     *
     * @param {boolean} inert - Whether it is out of reach.
     * @returns {void}
     */
    function setBehindDetail(inert: boolean): void {
        (document.querySelector('.topbar') as HTMLElement).inert = inert;
        $('view-queue').inert = inert;
    }

    /**
     * Draws the open panel from the queues last read. It is made anew only when its encounter changes stage, and
     * closes when the encounter is in no queue any more.
     *
     * @returns {void}
     */
    function drawDetail(): void {
        if (selected === undefined) {
            return;
        }

        const isIt = (e: IQueueEntry) => e.encounterId === selected;
        const queues = latest?.queues ?? {};
        const index = STAGES.findIndex(stage => queues[stage[0]]?.some(isIt));
        const stage = STAGES[index]?.[0];
        const entry = stage === undefined ? undefined : queues[stage]?.find(isIt);

        if (!entry) {
            closeDetail();

            return;
        }

        const key = `${stage}|${selected}`;
        const holder = $('detail');
        let sheet = holder.querySelector<HTMLElement>('.sheet');

        if (sheet?.dataset.key !== key) {
            const focused = sheet && (sheet.contains(document.activeElement) || document.activeElement === document.body);

            sheet?.remove();
            sheet = holder.appendChild(createSheet(entry, index));
            sheet.dataset.key = key;
            if (focused) {
                sheet.querySelector<HTMLElement>('.sheet-close')?.focus();
            }
        }
        updateSheet(sheet, entry, index);
        ticketNodes.forEach((ticket, ticketKey) => {
            ticket.dataset.selected = String(ticketKey === key);
        });
    }

    /**
     * Makes an encounter's panel: the HN, the wait and the facts on top; a section for each thing that can be done;
     * and the action that sends the patient on, pinned at the bottom.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {number} index - The stage's place in the stages.
     * @returns {HTMLElement}
     */
    function createSheet(entry: IQueueEntry, index: number): HTMLElement {
        const sheet = el('aside', undefined, 'sheet');
        const head = el('div', undefined, 'sheet-head');
        const top = el('div', undefined, 'sheet-top');
        const title = el('div', undefined, 'sheet-title');
        const hn = button(entry.hn || '—', 'hn-link sheet-hn');
        const close = el('button', undefined, 'sheet-close ghost');
        const body = el('div', undefined, 'sheet-body');
        const foot = el('div', undefined, 'sheet-foot');
        const go = button('', 'stage-go primary', 'arrow');
        const done = button('เสร็จสิ้น', 'stage-done secondary', 'check');

        sheet.setAttribute('role', 'dialog');
        sheet.setAttribute('aria-modal', 'true');
        sheet.setAttribute('aria-label', `รายละเอียดผู้ป่วย HN ${entry.hn || ''}`);
        hn.title = 'ดูห้องของผู้ป่วย';
        hn.addEventListener('click', () => revealRoom(entry.hn || ''));
        close.type = 'button';
        close.setAttribute('aria-label', 'ปิด');
        close.appendChild(icon('x'));
        close.addEventListener('click', () => closeDetail());
        title.append(el('span', 'ผู้ป่วย HN', 'sheet-eyebrow'), hn);
        top.append(title, close);
        head.append(top, createMeter(), el('dl', undefined, 'facts'));

        body.appendChild(createStepper(sheet, entry, STAGES[index][0]));
        if (STAGES[index][0] === 'examination') {
            body.appendChild(createDoctorSection(entry));
        }
        body.append(createVideoSection(entry), createQuestionnaireSection());

        // The second click of a double click would send the patient on twice.
        go.addEventListener('click', event => {
            if (event.detail < 2) {
                changeStage(entry, sheet.dataset.target ?? '', go);
            }
        });
        done.addEventListener('click', event => {
            if (event.detail < 2) {
                changeStage(entry, 'done', done);
            }
        });
        foot.append(go, done);
        sheet.append(head, body, foot);

        return sheet;
    }

    /**
     * Brings the panel up to date, leaving alone what has not changed.
     *
     * @param {HTMLElement} sheet - The panel.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {number} index - The stage's place in the stages.
     * @returns {void}
     */
    function updateSheet(sheet: HTMLElement, entry: IQueueEntry, index: number): void {
        const { doctor } = entry;

        updateMeter(sheet.querySelector('.meter') as HTMLElement, entry.waitedSeconds);
        drawFacts(sheet.querySelector('.facts') as HTMLElement, entry, index, doctor);
        updateStepper(sheet);
        updateDoctorSection(sheet, entry, doctor);
        updateVideoSection(sheet, entry);
        updateQuestionnaireSection(sheet, entry);
    }

    /**
     * Makes a section of the panel, with its heading.
     *
     * @param {string} className - The class.
     * @param {string} iconName - The heading's icon.
     * @param {string} title - The heading.
     * @returns {HTMLElement}
     */
    function createSection(className: string, iconName: string, title: string): HTMLElement {
        const section = el('section', undefined, `sheet-section ${className}`);
        const heading = el('h3');

        heading.append(icon(iconName), el('span', title));
        section.appendChild(heading);

        return section;
    }

    /**
     * Makes the meter of the patient's wait against the limit, with a tick where a wait starts to be long.
     *
     * @returns {HTMLElement}
     */
    function createMeter(): HTMLElement {
        const meter = el('div', undefined, 'meter');
        const top = el('div', undefined, 'meter-top');
        const label = el('span', undefined, 'meter-label');
        const value = el('span', undefined, 'meter-value');
        const track = el('div', undefined, 'meter-track');
        const tick = el('span', undefined, 'meter-tick');
        const scale = el('div', undefined, 'meter-scale');
        const warnAt = el('span', String(WAIT_WARN_SECONDS / 60), 'meter-warn-at');
        const caption = el('div', undefined, 'meter-caption');
        const atWarn = `${WAIT_WARN_SECONDS * 100 / WAIT_LONG_SECONDS}%`;

        label.append(icon('clock'), el('span', 'รอมาแล้ว'));
        value.append(el('b'), el('span', ` / ${waited(WAIT_LONG_SECONDS)} นาที`));
        top.append(label, value);
        tick.style.left = atWarn;
        track.append(el('span', undefined, 'meter-fill'), tick);
        warnAt.style.left = atWarn;
        scale.append(el('span', '0'), warnAt, el('span', String(WAIT_LONG_SECONDS / 60)));
        caption.append(icon('check'), el('span'));
        meter.append(top, track, scale, caption);

        return meter;
    }

    /**
     * Fills the meter: its colour is the wait's tier, which the caption says with an icon and words.
     *
     * @param {HTMLElement} meter - The meter.
     * @param {number} seconds - How long the patient has waited.
     * @returns {void}
     */
    function updateMeter(meter: HTMLElement, seconds: number): void {
        const tier = tierOf(seconds);
        const text = {
            long: `เกินเกณฑ์ ${WAIT_LONG_SECONDS / 60} นาทีมาแล้ว ${Math.floor((seconds - WAIT_LONG_SECONDS) / 60)} นาที`,
            ok: `ยังไม่ถึง ${WAIT_WARN_SECONDS / 60} นาที`,
            warn: `เกิน ${WAIT_WARN_SECONDS / 60} นาที อีก ${Math.ceil((WAIT_LONG_SECONDS - seconds) / 60)} นาทีถึงเกณฑ์`
        }[tier];
        const iconName = TIERS.find(t => t[0] === tier)?.[2] ?? 'clock';

        meter.dataset.tier = tier;
        setText(meter.querySelector('.meter-value b') as Element, waited(seconds));
        (meter.querySelector('.meter-fill') as HTMLElement).style.width
            = `${Math.min(100, seconds * 100 / WAIT_LONG_SECONDS)}%`;
        meter.querySelector('.meter-caption use')?.setAttribute('href', `#i-${iconName}`);
        setText(meter.querySelector('.meter-caption span') as Element, text);
    }

    /**
     * Draws the facts a coordinator checks first, in two columns.
     *
     * @param {HTMLElement} list - Their place.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {number} index - The stage's place in the stages.
     * @param {string|undefined} doctor - The encounter's doctor, if it has one.
     * @returns {void}
     */
    function drawFacts(list: HTMLElement, entry: IQueueEntry, index: number, doctor?: string): void {
        const [ stage, stageName, stageIcon ] = STAGES[index];
        const nhso = NHSO_STATUSES[entry.encounterId];
        const facts: { icon: string; key: string; label: string; tone?: string; value: string; }[] = [
            { icon: stageIcon, key: 'stage', label: 'ขั้นปัจจุบัน', value: stageName },
            { icon: 'stethoscope',
                key: 'doctor',
                label: 'แพทย์',
                value: doctor ?? (stage === 'examination' ? 'ยังไม่กำหนด' : '—') },
            { icon: 'key',
                key: 'nhso',
                label: 'สปสช.',
                tone: nhso,
                value: nhso ? NHSO_LABELS[nhso][0].replace('สปสช. ', '') : '—' },
            { icon: 'users', key: 'at', label: 'เจ้าหน้าที่อยู่ด้วย', value: entry.at?.join(', ') || 'ไม่มี' }
        ];

        if (entry.clinic) {
            facts.push({ icon: 'clipboard', key: 'clinic', label: 'คลินิก', value: CLINIC_NAMES[entry.clinic] ?? entry.clinic });
        }
        facts.push({ icon: 'hourglass',
            key: 'total',
            label: 'อยู่ในระบบมาแล้ว',
            value: duration(secondsInSystem(entry)) });

        if (!changed(list, facts)) {
            return;
        }
        list.textContent = '';
        facts.forEach(fact => {
            const box = el('div');
            const name = el('dt');

            box.dataset.fact = fact.key;
            box.dataset.tone = fact.tone ?? '';
            name.append(icon(fact.icon), el('span', fact.label));
            box.append(name, el('dd', fact.value));
            list.appendChild(box);
        });
    }

    /**
     * Makes the encounter's pathway as a vertical stepper: past stages ticked, the current one filled, and any other can
     * be picked as the stage to send the patient to; the next one is picked to begin with.
     *
     * @param {HTMLElement} sheet - The panel, which holds the picked stage.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage the encounter is in.
     * @returns {HTMLElement}
     */
    function createStepper(sheet: HTMLElement, entry: IQueueEntry, stage: string): HTMLElement {
        const section = createSection('stages', 'swap', 'เปลี่ยนขั้น');
        const steps = el('ol', undefined, 'steps');

        section.appendChild(el('p', 'กดเลือกขั้นที่จะส่งไป แล้วกดปุ่มด้านล่าง', 'sheet-hint'));
        const path = entry.pathwayStages.filter(id => id !== 'done');
        const index = path.indexOf(stage);

        sheet.dataset.target = path[index + 1] ?? 'done';
        path.forEach((id, i) => {
            const step = el('li', undefined, 'step');
            const current = i === index;
            const row = el(current ? 'div' : 'button', undefined, 'step-pick');
            const mark = el('span', undefined, 'step-mark');
            const tag = el('span', undefined, 'sheet-tag');

            step.dataset.stage = id;
            step.dataset.state = i < index ? 'past' : current ? 'current' : 'future';
            if (i < index) {
                mark.appendChild(icon('check'));
            } else {
                mark.textContent = String(i + 1);
            }
            tag.textContent = current ? 'อยู่ที่นี่' : 'จะส่งไป';
            row.append(mark, el('span', STAGE_NAMES[id] ?? id, 'step-name'), tag);

            // A stage ahead, even one the patient was sent back from, shows no time: only what is behind them does.
            const spent = i < index ? secondsSpent(entry, id) : undefined;

            if (spent !== undefined) {
                tag.before(createStepTime(spent));
            }
            if (current) {
                step.setAttribute('aria-current', 'step');
            } else {
                row.setAttribute('type', 'button');
                row.addEventListener('click', () => {
                    sheet.dataset.target = id;
                    updateStepper(sheet);
                });
            }
            step.appendChild(row);
            steps.appendChild(step);
        });
        section.appendChild(steps);

        return section;
    }

    /**
     * Makes the mark of how long a past stage took: a bar in the colour of its wait tier, and the minutes.
     *
     * @param {number} seconds - How long.
     * @returns {HTMLElement}
     */
    function createStepTime(seconds: number): HTMLElement {
        const tier = tierOf(seconds);
        const box = el('span', undefined, 'step-time');
        const bar = el('span', undefined, 'step-time-bar');

        // The longer the stage, the longer the bar, up to the limit.
        bar.style.width = `${Math.min(1, seconds / WAIT_LONG_SECONDS) * 4.5}rem`;
        box.dataset.tier = tier;
        box.title = `อยู่ในขั้นนี้ ${duration(seconds)} (${TIERS.find(t => t[0] === tier)?.[1]})`;
        box.append(bar, el('span', `${Math.floor(seconds / 60)} นาที`));

        return box;
    }

    /**
     * Marks the picked stage, and names it on the pinned action.
     *
     * @param {HTMLElement} sheet - The panel.
     * @returns {void}
     */
    function updateStepper(sheet: HTMLElement): void {
        const target = sheet.dataset.target ?? 'done';
        const toDone = target === 'done';
        const go = sheet.querySelector('.stage-go') as HTMLElement;

        sheet.querySelectorAll<HTMLElement>('.step').forEach(step => {
            const picked = step.dataset.stage === target;

            step.classList.toggle('target', picked);
            if (step.dataset.state !== 'current') {
                step.querySelector('button')?.setAttribute('aria-pressed', String(picked));
                (step.querySelector('.sheet-tag') as HTMLElement).hidden = !picked;
            }
        });
        setText(go.lastElementChild as Element, toDone ? 'เสร็จสิ้น' : `ส่งไป ${STAGE_NAMES[target] ?? target}`);
        go.querySelector('use')?.setAttribute('href', toDone ? '#i-check' : '#i-arrow');
        (sheet.querySelector('.stage-done') as HTMLElement).hidden = toDone;
    }

    /**
     * Makes the section that changes an encounter's doctor: a chip for each doctor who has patients, and a field for
     * another doctor's code.
     *
     * @param {Object} entry - The encounter's entry in the examination queue.
     * @returns {HTMLElement}
     */
    function createDoctorSection(entry: IQueueEntry): HTMLElement {
        const section = createSection('doctors', 'stethoscope', 'แพทย์');
        const other = el('div', undefined, 'doctor-other');
        const input = el('input', undefined, 'doctor-to');
        const set = button('กำหนด', 'doctor-set secondary');

        input.autocomplete = 'off';
        input.setAttribute('aria-label', `รหัสแพทย์ของ ${entry.hn || 'ผู้ป่วย'}`);
        input.placeholder = 'รหัสแพทย์อื่น';
        input.addEventListener('keydown', event => {
            if (event.key === 'Enter' && !set.disabled) {
                set.click();
            }
        });
        set.addEventListener('click', () => {
            const doctor = input.value.trim();

            input.value = '';
            setDoctor(entry, doctor || null, set);
        });
        other.append(input, set);
        section.append(el('div', undefined, 'doctor-chips'), other);

        return section;
    }

    /**
     * Draws the doctor chips, the encounter's own pressed.
     *
     * @param {HTMLElement} sheet - The panel.
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string|undefined} doctor - The encounter's doctor.
     * @returns {void}
     */
    function updateDoctorSection(sheet: HTMLElement, entry: IQueueEntry, doctor?: string): void {
        const chips = sheet.querySelector<HTMLElement>('.doctor-chips');
        const known = Object.keys(latest?.examination.doctors ?? {});

        if (!chips || !changed(chips, [ known, doctor ?? '' ])) {
            return;
        }
        chips.textContent = '';
        [ ...known, '' ].forEach(id => {
            const chip = el('button', id || 'ยังไม่กำหนด', 'doctor-chip');
            const pressed = id === (doctor ?? '');

            chip.type = 'button';
            chip.dataset.doctor = id;
            chip.setAttribute('aria-pressed', String(pressed));
            chip.addEventListener('click', () => {
                if (chip.getAttribute('aria-pressed') !== 'true') {
                    setDoctor(entry, id || null, chip);
                }
            });
            chips.appendChild(chip);
        });
    }

    /**
     * Makes the section of waiting videos: the stage's own, which plays and stops, and then the catalogue.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {HTMLElement}
     */
    function createVideoSection(entry: IQueueEntry): HTMLElement {
        const section = createSection('videos', 'play', 'วิดีโอระหว่างรอ');
        const now = el('div', undefined, 'sheet-item video-stage');
        const toggle = button('', 'video-toggle secondary', 'play');

        toggle.addEventListener('click', () => toggleVideo(entry, PLAYING_VIDEOS.has(entry.encounterId), toggle));
        now.append(el('span', undefined, 'sheet-item-name video-now'), toggle);

        const list = el('div', undefined, 'sheet-list');

        list.append(now, el('div', undefined, 'video-list'));
        section.appendChild(list);

        return section;
    }

    /**
     * Brings the waiting videos up to date. While one plays, only it can be stopped: another cannot be played over it.
     *
     * @param {HTMLElement} sheet - The panel.
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {void}
     */
    function updateVideoSection(sheet: HTMLElement, entry: IQueueEntry): void {
        const list = sheet.querySelector('.video-list') as HTMLElement;
        const toggle = sheet.querySelector('.video-toggle') as HTMLElement;
        const playing = PLAYING_VIDEOS.get(entry.encounterId);
        const title = VIDEO_CATALOGUE.find(v => v.id === playing)?.title ?? playing;
        const stage = sheet.dataset.key?.split('|')[0] ?? '';

        if (changed(list, VIDEO_CATALOGUE)) {
            list.textContent = '';
            VIDEO_CATALOGUE.forEach(video => {
                const row = el('div', undefined, 'sheet-item');
                const tag = el('span', undefined, 'sheet-tag');
                const choose = button('ตั้งประจำขั้น', 'video-choose ghost');
                const play = button('เล่น', 'video-play secondary', 'play');

                row.dataset.video = video.id;
                tag.append(icon('play'), el('span', 'กำลังเล่น'));
                choose.dataset.video = video.id;
                choose.title = 'ตั้งเป็นวิดีโอของขั้นนี้สำหรับผู้ป่วยรายนี้';
                choose.setAttribute('aria-label', `ตั้ง ${video.title} เป็นวิดีโอของขั้นนี้`);
                choose.addEventListener('click', () => chooseVideo(entry, stage, video.id, choose));
                play.dataset.video = video.id;
                play.setAttribute('aria-label', `เล่น ${video.title}`);
                play.addEventListener('click', () => toggleVideo(entry, false, play, video.id));
                row.append(el('span', video.title, 'sheet-item-name'), tag, choose, play);
                list.appendChild(row);
            });
        }
        list.querySelectorAll<HTMLElement>('.sheet-item').forEach(row => {
            row.classList.toggle('playing', row.dataset.video === playing);
            (row.querySelector('.sheet-tag') as HTMLElement).hidden = row.dataset.video !== playing;
            (row.querySelector('.video-play') as HTMLElement).hidden = playing !== undefined;
        });
        (toggle.parentElement as HTMLElement).classList.toggle('playing', playing !== undefined);
        setText(sheet.querySelector('.video-now') as Element,
            playing === undefined ? 'วิดีโอประจำขั้นนี้' : `กำลังเล่น: ${title}`);
        setText(toggle.lastElementChild as Element, playing === undefined ? 'เล่น' : 'หยุด');
        toggle.querySelector('use')?.setAttribute('href', playing === undefined ? '#i-play' : '#i-x');
    }

    /**
     * Makes the section of health questionnaires.
     *
     * @returns {HTMLElement}
     */
    function createQuestionnaireSection(): HTMLElement {
        const section = createSection('questionnaires', 'clipboard', 'แบบสอบถามสุขภาพ');

        section.appendChild(el('div', undefined, 'sheet-list'));

        return section;
    }

    /**
     * Draws the health questionnaires: each that can be sent or was sent, with what became of each sending, and the
     * answers.
     *
     * @param {HTMLElement} sheet - The panel.
     * @param {Object} entry - The encounter's entry in its queue.
     * @returns {void}
     */
    function updateQuestionnaireSection(sheet: HTMLElement, entry: IQueueEntry): void {
        const section = sheet.querySelector('.sheet-section.questionnaires') as HTMLElement;
        const list = section.querySelector('.sheet-list') as HTMLElement;
        const { catalogue } = questionnaires;
        const sent = questionnaires.sent[entry.encounterId] ?? [];

        section.hidden = !catalogue.length && !sent.length;
        if (!changed(list, [ catalogue, sent ])) {
            return;
        }
        list.textContent = '';

        // One that has left the catalogue since it was sent is still listed, to be read.
        const titles = new Map([ ...sent.map(q => [ q.questionnaire, q.title ] as const),
            ...catalogue.map(q => [ q.id, q.title ] as const) ]);

        titles.forEach((title, id) => {
            const row = el('div', undefined, 'sheet-item questionnaire');
            const sendings = sent.filter(q => q.questionnaire === id);

            row.dataset.questionnaire = id;
            row.appendChild(el('span', title, 'sheet-item-name'));
            if (catalogue.some(q => q.id === id)) {
                const send = button(sendings.length ? 'ส่งอีกครั้ง' : 'ส่ง', 'questionnaire-send secondary', 'arrow');

                send.setAttribute('aria-label', `ส่งแบบสอบถาม ${title}`);
                send.addEventListener('click', () => sendQuestionnaire(entry, id, send));
                row.appendChild(send);
            }
            sendings.forEach(q => {
                const [ tone, iconName, state ] = q.answers ? [ 'ok', 'check', 'ตอบแล้ว' ]
                    : q.closedAt ? [ '', 'ban', 'ปิดแล้ว (เจ้าหน้าที่เข้าห้อง)' ] : [ 'warn', 'clock', 'รอคำตอบ' ];
                const sending = el('div', undefined, 'sending');
                const tag = el('span', undefined, `sheet-tag ${tone}`);

                tag.append(icon(iconName), el('span', state));
                sending.appendChild(tag);
                q.answers?.forEach((answer, i) => {
                    sending.appendChild(el('div', `${q.questions[i].text} — ${q.questions[i].choices[answer]}`, 'answer'));
                });
                row.appendChild(sending);
            });
            list.appendChild(row);
        });
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
        closeDetail(false);
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
     * Plays a waiting video in the patient's room, or stops the one that plays.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {boolean} playing - Whether a video plays now, so that the click stops it.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @param {string} [video] - Which video to play; unset for the one of the patient's stage.
     * @returns {void}
     */
    function toggleVideo(entry: IQueueEntry, playing: boolean, trigger: HTMLButtonElement, video?: string): void {
        const hn = entry.hn || 'ผู้ป่วย';
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/video${playing ? '/stop' : ''}`;

        hold(trigger, act(path, video ? { video } : {}), result => {
            if (failed(result)) {
                say(playing ? 'หยุดวิดีโอไม่สำเร็จ' : 'เล่นวิดีโอไม่ได้ ขั้นนี้อาจไม่มีวิดีโอ หรือระบบเล่นวิดีโอไม่พร้อม', 'error');
            } else {
                say(playing ? `หยุดวิดีโอของ ${hn} แล้ว` : `เริ่มเล่นวิดีโอให้ ${hn} แล้ว`, 'ok');
            }
        });
    }

    /**
     * Chooses the waiting video a patient gets at a stage.
     *
     * @param {Object} entry - The encounter's entry in its queue.
     * @param {string} stage - The stage.
     * @param {string} video - The video.
     * @param {HTMLButtonElement} trigger - The button that asked, held down until the answer.
     * @returns {void}
     */
    function chooseVideo(entry: IQueueEntry, stage: string, video: string, trigger: HTMLButtonElement): void {
        const path = `/encounters/${encodeURIComponent(entry.encounterId)}/video-choice`;

        hold(trigger, act(path, { stage,
            video }), result => {
            say(failed(result) ? 'เลือกวิดีโอไม่สำเร็จ' : `เลือกวิดีโอของ ${entry.hn || 'ผู้ป่วย'} แล้ว`,
                failed(result) ? 'error' : 'ok');
        });
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

    $('stat-moves').addEventListener('click', () => showView('rooms'));
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

    // A click elsewhere, or Escape, closes the NHSO control and a team's names. With neither open, Escape closes the
    // encounter's panel.
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

        const popover = !$('nhso-pop').hidden || Array.from(teamNodes.values()).some(team => team.open);

        if (!popover) {
            closeDetail();
        }
        closeTeams();
        if (!$('nhso-pop').hidden) {
            showNhsoControl(false);
            $('nhso-chip').focus();
        }
    });
    // The second click of a double click on a card lands on the scrim, and must not close what the first opened.
    $('scrim').addEventListener('click', event => {
        if (event.detail < 2) {
            closeDetail();
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

                // The desk's clock may be wrong: how long a move has run is told by the service's.
                const now = Date.parse(response.headers.get('date') ?? '') || Date.now();

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
                    PLAYING_VIDEOS = new Map((state.videos ?? []).map(v => [ v.encounterId, v.video ]));
                    NHSO_STATUSES = state.nhso?.statuses ?? {};
                    drawNhso(state.nhso?.bypass ?? null);
                    VIDEO_CATALOGUE = state.videoCatalogue ?? [];

                    drawTeams(state.teams);
                    drawLegend(state.queues);
                    latest = state;
                    SERVICE_NOW = now;
                    drawBoard(state);
                    loadToday();
                    drawDetail();

                    // The rooms are drawn anew: a list being chosen from would close, and a field being typed in would
                    // lose its place.
                    if (!($('rooms').contains(document.activeElement)
                            && document.activeElement?.matches('select, input.move-hn'))) {
                        drawRooms(state.rooms, state.moves);
                    }
                    drawOutcomes(state.moves);

                    // After the rooms, which tell the movers' names.
                    drawMoves(state.moves, now);
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
    $('today-toggle').addEventListener('click', () => showToday(Boolean($('today').hidden)));
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
