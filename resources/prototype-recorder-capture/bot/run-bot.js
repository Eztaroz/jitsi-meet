#!/usr/bin/env node
/*
 * PROTOTYPE - recorder bot runner. Launches headless Chromium, loads
 * lib-jitsi-meet from the Jitsi web server, runs bot-page.js and writes one
 * WebM file per remote track plus timeline.json. Throwaway code.
 *
 * Usage: node run-bot.js --room <name> [--out <dir>] [--base https://localhost:8443]
 *          [--grace-ms 60000] [--max-height 720] [--constraint-schedule "30000:180,45000:720"]
 *          [--label-rebroadcast-ms 2000] [--no-attach-audio]
 */
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

function parseArgs(argv) {
    const args = {
        base: 'https://localhost:8443',
        out: path.join(__dirname, '..', 'out'),
        graceMs: 60000,
        maxHeight: 720,
        attachAudio: true,
        labelRebroadcastMs: 2000,
        constraintSchedule: []
    };

    for (let i = 2; i < argv.length; i++) {
        const a = argv[i];

        if (a === '--room') {
            args.room = argv[++i];
        } else if (a === '--out') {
            args.out = argv[++i];
        } else if (a === '--base') {
            args.base = argv[++i];
        } else if (a === '--grace-ms') {
            args.graceMs = Number(argv[++i]);
        } else if (a === '--max-height') {
            args.maxHeight = Number(argv[++i]);
        } else if (a === '--label-rebroadcast-ms') {
            args.labelRebroadcastMs = Number(argv[++i]);
        } else if (a === '--no-attach-audio') {
            args.attachAudio = false;
        } else if (a === '--constraint-schedule') {
            args.constraintSchedule = argv[++i].split(',').map(s => {
                const [ atMs, maxHeight ] = s.split(':').map(Number);

                return { atMs, maxHeight };
            });
        } else {
            throw new Error(`Unknown argument ${a}`);
        }
    }
    if (!args.room) {
        throw new Error('--room is required');
    }

    return args;
}

async function main() {
    const args = parseArgs(process.argv);
    const started = new Date();
    const outDir = path.join(args.out, `${args.room}-${started.toISOString().replace(/[:.]/g, '-')}`);
    const timelinePath = path.join(outDir, 'timeline.json');
    const events = [];

    fs.mkdirSync(outDir, { recursive: true });

    const params = {
        room: args.room,
        domain: 'meet.jitsi',
        muc: 'muc.meet.jitsi',
        websocketUrl: args.base.replace(/^http/, 'ws') + '/xmpp-websocket',
        jid: process.env.RECBOT_JID || 'recbot@recorder.meet.jitsi',
        password: process.env.RECBOT_PASSWORD || 'recbot-prototype-pass',
        sessionId: crypto.randomUUID(),
        graceMs: args.graceMs,
        maxHeight: args.maxHeight,
        attachAudio: args.attachAudio,
        labelRebroadcastMs: args.labelRebroadcastMs,
        constraintSchedule: args.constraintSchedule
    };

    const browser = await chromium.launch({
        args: [
            '--no-proxy-server',
            '--ignore-certificate-errors',
            '--autoplay-policy=no-user-gesture-required',

            // The page is served by route interception, so Chromium treats it as
            // a public origin and blocks its websocket to localhost.
            '--disable-features=LocalNetworkAccessChecks,PrivateNetworkAccessChecks'
        ]
    });
    const context = await browser.newContext({ ignoreHTTPSErrors: true });
    const page = await context.newPage();
    let resolveDone;
    const done = new Promise(resolve => {
        resolveDone = resolve;
    });

    await page.exposeFunction('recbotTimeline', ev => {
        events.push(ev);
        fs.writeFileSync(timelinePath, JSON.stringify({ params: { ...params, password: undefined }, events }, null, 2));
    });
    await page.exposeFunction('recbotChunk', (file, b64) => {
        fs.appendFileSync(path.join(outDir, file), Buffer.from(b64, 'base64'));
    });
    await page.exposeFunction('recbotDone', summary => resolveDone(summary));

    page.on('console', msg => {
        const text = msg.text();

        if (text.startsWith('[recbot]') || msg.type() === 'error') {
            console.log(`${new Date().toISOString()} ${text}`);
        }
    });
    page.on('pageerror', err => console.log(`${new Date().toISOString()} [pageerror] ${err.message}`));

    // Serve an empty page on the Jitsi origin so LJM can use the same-origin websocket.
    await page.route(`${args.base}/_recbot`, route => route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><html><head><title>recbot</title></head><body></body></html>'
    }));
    await page.goto(`${args.base}/_recbot`);
    await page.addScriptTag({ url: `${args.base}/libs/lib-jitsi-meet.min.js` });
    await page.evaluate(p => {
        window.RECBOT_PARAMS = p;
    }, params);
    await page.addScriptTag({ path: path.join(__dirname, 'bot-page.js') });

    const summary = await done;

    await browser.close();
    console.log(`${new Date().toISOString()} [runner] done ${JSON.stringify(summary)} -> ${outDir}`);
    console.log(`OUT_DIR=${outDir}`);
}

main().catch(err => {
    console.error(err);
    process.exit(1);
});
