import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type MockTimersOptions, afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { ARRIVAL_WAIT_MS, COUNTDOWN_MS, PREPARE_WAIT_MS } from '../src/rules.ts';
import { Store } from '../src/store.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const APIS: MockTimersOptions['apis'] = [ 'Date', 'setInterval', 'setTimeout' ];
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const staff = { endpointId: 'e-staff', hidden: false, identity: { user: { hospital_role: 'staff', id: 's-1', name: 'Sam' } } };
const patient = { endpointId: 'e-pat', hidden: false, identity: { user: { hospital_role: 'patient', id: 'p-1', name: 'Pat' } } };

/**
 * Lets the promises that are ready run, without waiting on any clock.
 *
 * @returns {Promise<void>}
 */
async function settle(): Promise<void> {
    for (let i = 0; i < 20; i++) {
        await nextTurn();
    }
}

/**
 * Moves the mock clock on, then lets the work it started run.
 *
 * @param {number} ms - How far.
 * @returns {Promise<void>}
 */
async function advance(ms: number): Promise<void> {
    mock.timers.tick(ms);
    await settle();
}

describe('the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let sent: { endpointId: string; room: string; }[];
    let recorded: string[];
    let botStatus: string;
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        mock.timers.enable({ apis: APIS, now: T0 });
        rooms = [];
        sent = [];
        recorded = [];
        botStatus = 'starting';
        store = new Store(mkdtempSync(join(tmpdir(), 'service-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { lounges: [], stations: [] },
            prosody: {
                rooms: async () => ({ rooms }),
                sendMove: async ({ endpointId, room }: { endpointId: string; room: string; }) => {
                    sent.push({ endpointId, room });
                }
            } as unknown as Prosody,
            recorderBot: {
                recordRoom: async (hn: string) => {
                    recorded.push(hn);

                    return 'c-1';
                },
                status: async () => botStatus,
                stop: async () => undefined
            } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
    });

    afterEach(() => {
        service.stop();
        store.close();
        mock.timers.reset();
    });

    const stateOf = (moveId: string) => service.state.moves.find(m => m.id === moveId);

    it('sends a participant to an open room and fails the move when they do not arrive in time', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        assert.equal(move.state, 'counting_down');
        assert.deepEqual(sent, [ { endpointId: 'e-staff', room: 'a' } ]);

        await advance(COUNTDOWN_MS + ARRIVAL_WAIT_MS - 1);
        assert.equal(stateOf(move.id)?.state, 'counting_down');

        await advance(1);
        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'participant_did_not_arrive');
    });

    it('notices the arrival by polling the rooms while the move is under way', async () => {
        rooms = [ { name: 'a', occupants: [ staff ] }, { name: 'b', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-staff', fromRoom: 'a', toRoom: 'b' }, 'system');

        rooms = [ { name: 'a', occupants: [] }, { name: 'b', occupants: [ patient, staff ] } ];
        await advance(1000);

        assert.equal(stateOf(move.id)?.state, 'done');
    });

    it('opens a closed patient room through the recorder bot and sends the patient once the bot is in it', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'hn-b' }, 'system');

        await settle();
        assert.equal(move.state, 'preparing');
        assert.deepEqual(recorded, [ 'hn-b' ]);
        assert.deepEqual(sent, []);

        await advance(500);
        assert.deepEqual(sent, []);

        botStatus = 'recording';
        await advance(500);
        assert.equal(sent.length, 1);
        assert.equal(stateOf(move.id)?.state, 'counting_down');
    });

    it('fails the move when the recorder bot is not in the opened room within the wait', async () => {
        rooms = [ { name: 'hn-a', occupants: [ patient ] } ];

        const move = await service.requestMove({ endpointId: 'e-pat', fromRoom: 'hn-a', toRoom: 'hn-b' }, 'system');

        for (let waited = 0; waited < PREPARE_WAIT_MS; waited += 500) {
            await advance(500);
        }

        assert.equal(stateOf(move.id)?.state, 'failed');
        assert.equal(stateOf(move.id)?.reason, 'recorder_bot_not_ready');
        assert.deepEqual(sent, []);
    });

    it('closes the day\'s open encounters at the next midnight', async () => {
        await service.startEncounter('HN1');
        service.startDayEnds();

        await advance(15 * 3600_000 + 59 * 60_000);
        assert.equal(service.state.encounters[0].stage, 'waiting');

        await advance(60_000);
        assert.equal(service.state.encounters[0].stage, 'done');
        assert.equal(service.state.encounters[0].unfinished, true);
    });
});
