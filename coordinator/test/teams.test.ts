import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const staffOf = (id: string, name: string) =>
    ({ endpointId: `e-${id}`, hidden: false, identity: { user: { hospital_role: 'staff', id, name } } });
const patientOf = (id: string) =>
    ({ endpointId: `e-${id}`, hidden: false, identity: { user: { hospital_role: 'patient', id, name: id } } });

const sam = staffOf('s-1', 'Sam');
const lee = staffOf('s-2', 'Lee');
const pat = patientOf('p-1');

describe('stations as teams, through the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        rooms = [];
        store = new Store(mkdtempSync(join(tmpdir(), 'teams-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: {
                centers: [ {
                    id: 'c1',
                    stations: [
                        { id: 'intake', lounge: 'lounge-intake', stage: 'intake' },
                        { id: 'exam', lounge: 'lounge-exam', stage: 'examination' }
                    ]
                } ]
            },
            prosody: { rooms: async () => ({ rooms }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
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

    afterEach(async () => {
        for (let i = 0; i < 10; i++) {
            await nextTurn();
        }
        service.stop();
        store.close();
    });

    const teamOf = async (id: string) => (await service.teams(await service.rooms())).find(t => t.id === id);

    it('lists every station, with no one when its lounge is empty', async () => {
        const teams = await service.teams(await service.rooms());

        assert.deepEqual(teams.map(t => [ t.id, t.stage, t.lounge, t.free, t.busy ]),
            [ [ 'intake', 'intake', 'lounge-intake', [], [] ], [ 'exam', 'examination', 'lounge-exam', [], [] ] ]);
    });

    it('shows staff in the lounge as free', async () => {
        rooms = [ { name: 'lounge-intake', occupants: [ sam, lee ] } ];

        const team = await teamOf('intake');

        assert.deepEqual(team?.free.map(m => m.name), [ 'Sam', 'Lee' ]);
        assert.deepEqual(team?.busy, []);
    });

    it('shows staff in a patient\'s room as busy, with the patient they are with', async () => {
        const encounter = (await service.startEncounter('HN/1')).encounter;

        rooms = [ { name: 'lounge-intake', occupants: [ sam ] } ];
        await service.rooms();
        rooms = [ { name: 'lounge-intake', occupants: [] }, { name: 'HN/1', occupants: [ pat, sam ] } ];

        const team = await teamOf('intake');

        assert.deepEqual(team?.free, []);
        assert.deepEqual(team?.busy.map(m => [ m.name, m.hn, m.encounterId ]), [ [ 'Sam', 'HN/1', encounter?.id ] ]);
    });

    it('returns a staff member to free when they come back to the lounge', async () => {
        await service.startEncounter('HN/1');
        rooms = [ { name: 'lounge-intake', occupants: [ sam ] } ];
        await service.rooms();
        rooms = [ { name: 'HN/1', occupants: [ pat, sam ] } ];
        assert.equal((await teamOf('intake'))?.busy.length, 1);
        rooms = [ { name: 'lounge-intake', occupants: [ sam ] }, { name: 'HN/1', occupants: [ pat ] } ];

        const team = await teamOf('intake');

        assert.equal(team?.free.length, 1);
        assert.equal(team?.busy.length, 0);
    });

    it('leaves out staff in a patient\'s room whose station is not known', async () => {
        await service.startEncounter('HN/1');
        rooms = [ { name: 'HN/1', occupants: [ pat, sam ] } ];

        const teams = await service.teams(await service.rooms());

        assert.deepEqual(teams.flatMap(t => [ ...t.free, ...t.busy ]), []);
    });

    it('shows a patient at the station whose staff are in their room, and others in their queue', async () => {
        const a = (await service.startEncounter('HN/1')).encounter;
        const b = (await service.startEncounter('HN/2')).encounter;

        rooms = [ { name: 'lounge-intake', occupants: [ sam ] } ];
        await service.rooms();
        rooms = [ { name: 'HN/1', occupants: [ pat, sam ] }, { name: 'HN/2', occupants: [ patientOf('p-2') ] } ];

        const waiting = service.queues(await service.rooms()).waiting;

        assert.deepEqual(waiting.find(e => e.encounterId === a?.id)?.at, [ 'intake' ]);
        assert.equal(waiting.find(e => e.encounterId === b?.id)?.at, undefined);
    });

    it('names every station whose staff are in the patient\'s room', async () => {
        const a = (await service.startEncounter('HN/1')).encounter;

        rooms = [ { name: 'lounge-intake', occupants: [ sam ] }, { name: 'lounge-exam', occupants: [ lee ] } ];
        await service.rooms();
        rooms = [ { name: 'HN/1', occupants: [ pat, sam, lee ] } ];

        const entry = service.queues(await service.rooms()).waiting.find(e => e.encounterId === a?.id);

        assert.deepEqual(entry?.at?.slice().sort(), [ 'exam', 'intake' ]);
    });
});
