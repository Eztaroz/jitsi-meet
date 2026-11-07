#!/usr/bin/env node
/*
 * PROTOTYPE - end-to-end check of the recorder bot against the real Jitsi web
 * UI. Throwaway code.
 *
 * Scenario "visit": bot joins first, patient joins, staff visits, leaves,
 *   comes back, then ends the meeting for everyone. Expect the bot to stop
 *   at once. Mid-call the bot lowers and restores its receive resolution.
 * Scenario "grace": patient joins, drops, comes back within the grace period,
 *   then leaves for good. Expect the bot to stop 60 s after the last leave.
 *
 * Usage: node run-test.js <visit|grace|all> --media <dir> --out <dir> [--shots <dir>]
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const BASE = 'https://localhost:8443';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString(), '[test]', ...a);

function parseArgs(argv) {
    const args = { scenario: argv[2] || 'all' };

    for (let i = 3; i < argv.length; i++) {
        if (argv[i] === '--media') {
            args.media = argv[++i];
        } else if (argv[i] === '--out') {
            args.out = argv[++i];
        } else if (argv[i] === '--shots') {
            args.shots = argv[++i];
        }
    }
    args.shots = args.shots || path.join(args.out, 'screenshots');
    fs.mkdirSync(args.shots, { recursive: true });

    return args;
}

function startBot(room, out, extra = []) {
    const envArgs = (process.env.BOT_EXTRA_ARGS || '').split(' ').filter(Boolean);
    const child = spawn(process.execPath, [
        path.join(__dirname, '..', 'bot', 'run-bot.js'), '--room', room, '--out', out, ...extra, ...envArgs
    ]);

    log(`bot pid ${child.pid}`);
    const state = { child, joined: null, exited: null, outDir: null, lines: [] };

    state.joined = new Promise((resolve, reject) => {
        const onData = buf => {
            for (const line of buf.toString().split('\n')) {
                if (!line) {
                    continue;
                }
                state.lines.push(line);
                console.log(`    [bot] ${line}`);
                if (line.includes('[recbot] bot_joined')) {
                    resolve();
                }
                if (line.includes('connection_failed')) {
                    reject(new Error(line));
                }
                const m = line.match(/^OUT_DIR=(.*)$/);

                if (m) {
                    state.outDir = m[1];
                }
            }
        };

        child.stdout.on('data', onData);
        child.stderr.on('data', onData);
    });
    state.exited = new Promise(resolve => child.on('exit', code => resolve({ code, at: new Date() })));

    return state;
}

async function launchParticipant(name, media) {
    const who = name.toLowerCase();
    const browser = await chromium.launch({
        args: [
            '--no-proxy-server',
            '--ignore-certificate-errors',
            '--autoplay-policy=no-user-gesture-required',
            '--use-fake-ui-for-media-stream',
            '--use-fake-device-for-media-stream',
            `--use-file-for-fake-video-capture=${path.join(media, `${who}.mjpeg`)}`,
            `--use-file-for-fake-audio-capture=${path.join(media, `${who}.wav`)}`
        ]
    });
    const context = await browser.newContext({
        ignoreHTTPSErrors: true,
        permissions: [ 'camera', 'microphone' ],
        viewport: { width: 1280, height: 720 }
    });

    return { name, browser, context, page: null };
}

async function join(p, room) {
    // Prejoin is off server side (ENABLE_PREJOIN_PAGE=false). Overriding it in
    // the URL makes jitsi-meet join without camera and microphone.
    const hash = [
        'config.disableDeepLinking=true',
        `userInfo.displayName=%22${p.name}%22`
    ].join('&');

    p.page = await p.context.newPage();
    p.page.on('pageerror', e => log(`${p.name} pageerror: ${e.message}`));
    await p.page.goto(`${BASE}/${room}#${hash}`);
    await p.page.waitForFunction(
        () => window.APP && APP.store.getState()['features/base/conference'].conference,
        null, { timeout: 30000 });
    log(`${p.name} joined ${room}`);
}

async function leave(p) {
    await p.page.close();
    p.page = null;
    log(`${p.name} left`);
}

// What a participant's own UI knows about the room and the recording.
async function inspectView(p, shotPath) {
    const view = await p.page.evaluate(() => {
        const state = APP.store.getState();
        const parts = state['features/base/participants'];
        const conference = state['features/base/conference'].conference;
        const sessions = state['features/recording'].sessionDatas || [];

        return {
            localRole: parts.local && parts.local.role,
            remoteInRedux: [ ...parts.remote.values() ].map(r => ({ id: r.id, name: r.name, role: r.role })),
            membersInLjm: conference.getParticipants().map(m => ({
                id: m.getId(),
                name: m.getDisplayName(),
                hidden: m.isHidden(),
                jid: m.getJid()
            })),
            recordingSessions: sessions.map(s => ({ id: s.id, mode: s.mode, status: s.status })),
            remoteTiles: document.querySelectorAll('#filmstripRemoteVideosContainer .videocontainer').length
        };
    });

    await sleep(500);
    await p.page.screenshot({ path: shotPath });
    view.screenshot = shotPath;

    // Tile view shows every participant the UI knows about.
    const tilePath = shotPath.replace(/\.png$/, '-tiles.png');

    await p.page.evaluate(() => APP.store.dispatch({ type: 'SET_TILE_VIEW', enabled: true }));
    await sleep(1500);
    await p.page.screenshot({ path: tilePath });
    await p.page.evaluate(() => APP.store.dispatch({ type: 'SET_TILE_VIEW', enabled: false }));
    view.tileScreenshot = tilePath;
    log(`${p.name} view: ${JSON.stringify(view)}`);

    return view;
}

async function scenarioVisit(args) {
    const room = 'hn0000001';
    const results = { scenario: 'visit', room, checks: {} };
    const bot = startBot(room, args.out, [ '--constraint-schedule', '40000:180,55000:720' ]);

    await bot.joined;
    const patient = await launchParticipant('Patient', args.media);
    const staff = await launchParticipant('Staff', args.media);

    await join(patient, room);
    await sleep(10000);
    await join(staff, room);
    await sleep(10000);
    results.checks.patientView1 = await inspectView(patient, path.join(args.shots, 'visit-patient-view.png'));
    results.checks.staffView1 = await inspectView(staff, path.join(args.shots, 'visit-staff-view.png'));
    await sleep(5000);
    await leave(staff);
    await sleep(10000);
    await join(staff, room);
    await sleep(15000);

    // Anonymous test deployment: the patient is moderator (first human).
    // Hand moderator to staff, as a staff login would give in production.
    const staffId = await staff.page.evaluate(() => APP.store.getState()['features/base/conference'].conference.myUserId());

    await patient.page.evaluate(id => APP.store.getState()['features/base/conference'].conference.grantOwner(id), staffId);
    await sleep(2000);
    results.checks.staffView2 = await inspectView(staff, path.join(args.shots, 'visit-staff-view-2.png'));

    const endAt = new Date();

    log('staff ends the meeting for all');
    await staff.page.evaluate(() => APP.store.getState()['features/base/conference'].conference.end());
    const exit = await Promise.race([ bot.exited, sleep(30000).then(() => null) ]);

    results.checks.botStopAfterEndMs = exit ? exit.at - endAt : null;
    results.outDir = bot.outDir;
    await patient.browser.close();
    await staff.browser.close();
    if (!exit) {
        bot.child.kill();
    }

    return results;
}

async function scenarioGrace(args) {
    const room = 'hn0000002';
    const results = { scenario: 'grace', room, checks: {} };
    const bot = startBot(room, args.out);

    await bot.joined;
    const patient = await launchParticipant('Patient', args.media);

    await join(patient, room);
    await sleep(15000);
    await leave(patient);
    await sleep(10000);
    await join(patient, room);
    await sleep(10000);
    await leave(patient);
    const lastLeave = new Date();
    const exit = await Promise.race([ bot.exited, sleep(120000).then(() => null) ]);

    results.checks.botStopAfterLastLeaveMs = exit ? exit.at - lastLeave : null;
    results.outDir = bot.outDir;
    await patient.browser.close();
    if (!exit) {
        bot.child.kill();
    }

    return results;
}

async function main() {
    const args = parseArgs(process.argv);
    const all = [];

    if (args.scenario === 'visit' || args.scenario === 'all') {
        all.push(await scenarioVisit(args));
    }
    if (args.scenario === 'grace' || args.scenario === 'all') {
        all.push(await scenarioGrace(args));
    }
    const resultPath = path.join(args.out, `test-results-${args.scenario}.json`);

    fs.writeFileSync(resultPath, JSON.stringify(all, null, 2));
    log(`results -> ${resultPath}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
