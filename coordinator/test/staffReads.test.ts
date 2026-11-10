import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';

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

const SAM = { id: 's-1', name: 'Sam' };
const sam = { endpointId: 'e-sam', hidden: false, identity: { user: { hospital_role: 'staff', id: 's-1', name: 's-1' } } };

describe('staff reads of the rooms', () => {
    let dumps: number;
    let rooms: { name: string; occupants: unknown[]; }[];
    let service: CoordinatorService;
    let store: Store;

    beforeEach(() => {
        mock.timers.enable({ apis: [ 'Date' ], now: Date.parse('2026-11-01T09:00:00Z') });
        dumps = 0;
        rooms = [ { name: 'lounge-intake', occupants: [ sam ] } ];
        store = new Store(mkdtempSync(join(tmpdir(), 'staff-reads-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [ { id: 'c1', stations: [ { id: 'intake', lounge: 'lounge-intake', stage: 'intake' } ] } ] },
            prosody: {
                rooms: async () => {
                    dumps++;

                    return { rooms };
                }
            } as unknown as Prosody,
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

    afterEach(() => {
        mock.timers.reset();
        service.stop();
        store.close();
    });

    it('share one dump of the rooms within a second, concurrent or not', async () => {
        await Promise.all([ service.staffContext(SAM), service.staffContext(SAM) ]);
        await service.staffContext(SAM);

        assert.equal(dumps, 1);
    });

    it('ask Prosody again once the snapshot is a second old', async () => {
        await service.staffContext(SAM);
        mock.timers.tick(1001);
        rooms = [];

        assert.equal((await service.staffContext(SAM)).where, 'nowhere');
        assert.equal(dumps, 2);
    });

    it('do not feed the actions: a stage change reads the rooms afresh', async () => {
        await service.staffContext(SAM);
        await service.staffChangeStage('nope', 'intake', SAM);

        assert.equal(dumps, 2);
    });
});
