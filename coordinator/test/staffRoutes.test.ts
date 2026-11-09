import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApi } from '../src/api.ts';
import type { CoordinatorService, IStaffStageResult, VideoRefusal } from '../src/coordinatorService.ts';
import { signToken } from '../src/jwt.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import type { ICoordinatorAuth } from '../src/screenAuth.ts';

const hospital = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});
const seconds = Math.floor(Date.now() / 1000);

const staffAuth: ICoordinatorAuth = {
    acceptedAudiences: [ 'jitsi' ],
    acceptedIssuers: [ 'chat' ],
    keyFor: async kid => kid === 'hospital/key' ? hospital.publicKey : undefined,
    marker: parseRoleMarker('user.hospital_role=staff', 'X') as never
};

/**
 * Signs a token of the hospital's issuer.
 *
 * @param {string} role - The role marker's value.
 * @param {string} id - The verified identity id.
 * @returns {string}
 */
function tokenOf(role: string, id = 's-1'): string {
    return signToken({
        claims: {
            aud: 'jitsi',
            context: { user: { hospital_role: role, id, name: 'Sam' } },
            exp: seconds + 3600,
            iss: 'chat',
            sub: 'meet.jitsi'
        },
        kid: 'hospital/key',
        privateKey: hospital.privateKey
    });
}

describe('the staff API', () => {
    const asked: unknown[][] = [];
    const videoAsked: unknown[][] = [];
    let videoRefusal: VideoRefusal | undefined;
    let result: IStaffStageResult = { moved: true };
    let server: Server;
    let base: string;

    before(async () => {
        const service = {
            staffChangeStage: async (...args: unknown[]) => {
                asked.push(args);

                return result;
            },
            staffContext: async (staff: unknown) => ({ staff, where: 'nowhere' }),
            staffPlayVideo: async (...args: unknown[]) => {
                videoAsked.push([ 'playVideo', ...args ]);

                return videoRefusal ? { refused: videoRefusal } : { video: 'b' };
            },
            staffSetVideo: async (...args: unknown[]) => {
                videoAsked.push([ 'setVideo', ...args ]);

                return videoRefusal ? { refused: videoRefusal } : {};
            },
            staffStopVideo: async (...args: unknown[]) => {
                videoAsked.push([ 'stopVideo', ...args ]);

                return videoRefusal ? { refused: videoRefusal } : {};
            }
        } as unknown as CoordinatorService;

        server = createApi({ secret: 'shared', service, staff: staffAuth });
        await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
        base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    after(() => {
        server.close();
    });

    const post = (token: string | undefined, body: unknown = { stage: 'billing' }) =>
        fetch(`${base}/staff/encounters/e-1/stage`, {
            body: JSON.stringify(body),
            headers: { 'content-type': 'application/json', ...token ? { authorization: `Bearer ${token}` } : {} },
            method: 'POST'
        });

    it('accepts a valid staff token, and names the staff member to the service', async () => {
        const response = await post(tokenOf('staff', 's-7'));

        assert.equal(response.status, 200);
        assert.deepEqual(asked.at(-1), [ 'e-1', 'billing', { id: 's-7', name: 'Sam' } ]);
    });

    it('refuses a request without a token', async () => {
        assert.equal((await post(undefined)).status, 401);
    });

    it('refuses a token that is not a staff member\'s, and the shared secret', async () => {
        const wrong = await post(tokenOf('patient'));

        assert.equal(wrong.status, 403);
        assert.deepEqual(await wrong.json(), { error: 'not_a_staff_member' });
        assert.equal((await post('shared')).status, 403);
        assert.equal((await post(tokenOf('coordinator'))).status, 403);
    });

    it('refuses a stage that is not text', async () => {
        assert.equal((await post(tokenOf('staff'), { stage: 3 })).status, 400);
    });

    it('answers a refusal of the rules with the reason', async () => {
        result = { moved: false, refused: 'done_is_not_for_staff' };
        assert.equal((await post(tokenOf('staff'), { stage: 'done' })).status, 403);

        result = { moved: false, refused: 'not_in_patients_room' };

        const response = await post(tokenOf('staff'));

        assert.equal(response.status, 403);
        assert.deepEqual(await response.json(), { error: 'not_in_patients_room' });

        result = { moved: false, refused: 'unknown_encounter' };
        assert.equal((await post(tokenOf('staff'))).status, 404);
    });

    it('lets a staff member choose, play and stop a video, naming them to the service', async () => {
        const sam = { id: 's-7', name: 'Sam' };
        const call = (path: string, body: unknown = {}, token = tokenOf('staff', 's-7')) =>
            fetch(`${base}/staff/encounters/e-1${path}`, {
                body: JSON.stringify(body),
                headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
                method: 'POST'
            });

        assert.equal((await call('/video-choice', { stage: 'waiting', video: 'b' })).status, 200);
        assert.deepEqual(videoAsked.at(-1), [ 'setVideo', 'e-1', 'waiting', 'b', sam ]);
        assert.equal((await call('/video-choice', { stage: 'waiting' })).status, 400);

        const played = await call('/video');

        assert.deepEqual([ played.status, await played.json() ], [ 200, { video: 'b' } ]);
        assert.deepEqual(videoAsked.at(-1), [ 'playVideo', 'e-1', sam ]);
        assert.equal((await call('/video/stop')).status, 200);
        assert.deepEqual(videoAsked.at(-1), [ 'stopVideo', 'e-1', sam ]);
        assert.equal((await call('/video', {}, tokenOf('patient'))).status, 403);
        assert.equal((await call('/video', {}, 'shared')).status, 403);

        videoRefusal = 'not_in_patients_room';

        const refused = await call('/video/stop');

        assert.equal(refused.status, 403);
        assert.deepEqual(await refused.json(), { error: 'not_in_patients_room' });
        videoRefusal = undefined;
    });

    it('tells a staff member where they are', async () => {
        const response = await fetch(`${base}/staff/me`, { headers: { authorization: `Bearer ${tokenOf('staff')}` } });

        assert.equal(response.status, 200);
        assert.equal(((await response.json()) as { where: string; }).where, 'nowhere');
        assert.equal((await fetch(`${base}/staff/me`)).status, 401);
    });
});
