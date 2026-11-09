import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import { setImmediate as nextTurn } from 'node:timers/promises';

import { CoordinatorService } from '../src/coordinatorService.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { type ILayout, parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';
import { type IVideoPlayer, VideoPlayerUnavailableError } from '../src/videoPlayer.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const APIS: ('Date' | 'setInterval' | 'setTimeout')[] = [ 'Date', 'setInterval', 'setTimeout' ];
const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const occupant = (endpointId: string, role: string, id: string) =>
    ({ endpointId, hidden: false, identity: { user: { hospital_role: role, id } } });
const patient = occupant('e-pat', 'patient', 'p-1');
const doctor = occupant('e-doc', 'staff', 's-1');
const nurse = occupant('e-nurse', 'staff', 's-2');

const LAYOUT: ILayout = {
    centers: [ {
        id: 'c1',
        pathways: [ { id: 'default', stages: [
            { id: 'waiting', name: 'W', defaultVideo: 'intro' },
            { id: 'examination', name: 'E' },
            { id: 'done', name: 'D' }
        ] } ],
        stations: [ { id: 'exam', lounge: 'lounge-exam', stage: 'examination' } ]
    } ],
    videos: [ { file: 'videos/intro.mp4', id: 'intro', title: 'Intro' } ]
};

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

describe('waiting videos, through the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let played: { room: string; token: string; videoUrl: string; }[];
    let stopped: string[];
    let playing: string[];
    let unavailable: string | undefined;
    let service: CoordinatorService;
    let store: Store;

    const fake: IVideoPlayer = {
        play: async request => {
            if (unavailable) {
                throw new VideoPlayerUnavailableError(unavailable);
            }
            played.push(request);
            playing.push(request.room);
        },
        playingRooms: async () => playing,
        stop: async room => {
            stopped.push(room);
            playing = playing.filter(r => r !== room);
        }
    };

    beforeEach(() => {
        mock.timers.enable({ apis: APIS, now: T0 });
        rooms = [];
        played = [];
        stopped = [];
        playing = [];
        unavailable = undefined;
        store = new Store(mkdtempSync(join(tmpdir(), 'video-')));
        service = new CoordinatorService({
            auditKey: 'audit-key',
            layout: LAYOUT,
            prosody: { rooms: async () => ({ rooms }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X'),
                videoPlayer: parseRoleMarker('user.hospital_role=video_player', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' },
            videoBaseUrl: 'https://meet.example/',
            videoPlayer: fake
        });
    });

    afterEach(() => {
        service.stop();
        store.close();
        mock.timers.reset();
    });

    const startEncounter = async (hn = 'HN/1') => {
        const result = await service.startEncounter(hn);

        return result.encounter as NonNullable<typeof result.encounter>;
    };
    const claimsOf = (token: string) => JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString('utf8'));
    const audit = () => service.audit(50).filter(e => e.kind === 'video');

    it('plays the stage\'s default video into the patient\'s room, with a video player token', async () => {
        const e = await startEncounter();
        const result = await service.playVideo(e.id, 'coord-1');

        assert.equal(result.refused, undefined);
        assert.equal(played.length, 1);
        assert.equal(played[0].room, 'HN/1');
        assert.equal(played[0].videoUrl, 'https://meet.example/videos/intro.mp4');

        const claims = claimsOf(played[0].token);

        assert.equal(claims.context.user.hospital_role, 'video_player');
        assert.equal(claims.room, 'hn%2f1');
    });

    it('refuses a video id it does not know, and plays nothing', async () => {
        const e = await startEncounter();
        const result = await service.playVideo(e.id, 'coord-1', 'nope');

        assert.equal(result.refused, 'unknown_video');
        assert.equal(played.length, 0);
        assert.deepEqual(audit().map(a => [ a.outcome, a.reason ]), [ [ 'refused', 'unknown_video' ] ]);
    });

    it('refuses a stage that has no default video', async () => {
        const e = await startEncounter();

        await service.changeStage(e.id, 'examination', 'system');
        assert.equal((await service.playVideo(e.id, 'coord-1')).refused, 'no_video');
    });

    it('refuses to start a second video in the same room', async () => {
        const e = await startEncounter();

        await service.playVideo(e.id, 'coord-1');
        assert.equal((await service.playVideo(e.id, 'coord-1')).refused, 'already_playing');
        assert.equal(played.length, 1);
    });

    it('refuses when the video player cannot be reached', async () => {
        const e = await startEncounter();

        unavailable = 'at_capacity';
        assert.equal((await service.playVideo(e.id, 'coord-1')).refused, 'video_player_unavailable');
        assert.equal(service.playingVideos().length, 0);
    });

    it('stops a video on request, and audits both', async () => {
        const e = await startEncounter();

        await service.playVideo(e.id, 'coord-1');
        const result = await service.stopVideo(e.id, 'coord-1');

        assert.equal(result.refused, undefined);
        assert.deepEqual(stopped, [ 'HN/1' ]);
        assert.deepEqual(service.playingVideos(), []);
        assert.deepEqual(audit().map(a => [ a.action, a.issuer, a.outcome, a.video ]).reverse(),
            [ [ 'play', 'coord-1', 'ok', 'intro' ], [ 'stop', 'coord-1', 'ok', 'intro' ] ]);
    });

    it('refuses to stop when nothing plays', async () => {
        const e = await startEncounter();

        assert.equal((await service.stopVideo(e.id, 'coord-1')).refused, 'not_playing');
    });

    it('stops the video when a staff member joins the room after it started', async () => {
        const e = await startEncounter();

        rooms = [ { name: 'HN/1', occupants: [ patient ] } ];
        await service.playVideo(e.id, 'coord-1');
        await advance(1000);
        assert.deepEqual(stopped, []);

        rooms = [ { name: 'HN/1', occupants: [ patient, doctor ] } ];
        await advance(1000);
        assert.deepEqual(stopped, [ 'HN/1' ]);
        assert.deepEqual(service.playingVideos(), []);
        assert.ok(audit().some(a => a.action === 'stop' && a.issuer === 'system' && a.reason === 'staff_joined'));
    });

    it('keeps playing when the staff member who started it from inside the room leaves', async () => {
        const e = await startEncounter();

        rooms = [ { name: 'HN/1', occupants: [ patient, doctor ] } ];
        await service.playVideo(e.id, 'coord-1');
        await advance(1000);
        rooms = [ { name: 'HN/1', occupants: [ patient ] } ];
        await advance(1000);
        assert.deepEqual(stopped, []);
        assert.equal(service.playingVideos().length, 1);

        rooms = [ { name: 'HN/1', occupants: [ patient, nurse ] } ];
        await advance(1000);
        assert.deepEqual(stopped, [ 'HN/1' ]);
    });

    it('forgets the video when it ends, so that another can play', async () => {
        const e = await startEncounter();

        await service.playVideo(e.id, 'coord-1');
        playing = [];
        await advance(1000);
        assert.deepEqual(service.playingVideos(), []);
        assert.equal((await service.playVideo(e.id, 'coord-1')).refused, undefined);
        assert.equal(played.length, 2);
    });
});
