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
import type { IVideoPlayer } from '../src/videoPlayer.ts';

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
const SAM = { id: 's-1', name: 'Sam' };

const LAYOUT: ILayout = {
    centers: [ {
        id: 'c1',
        pathways: [ { id: 'default', stages: [
            { id: 'waiting', name: 'W', defaultVideo: 'intro' },
            { id: 'examination', name: 'E' },
            { id: 'billing', name: 'B' },
            { id: 'done', name: 'D' }
        ] } ],
        stations: [ { id: 'exam', lounge: 'lounge-exam', stage: 'examination' } ]
    } ],
    videos: [
        { file: 'videos/intro.mp4', id: 'intro', title: 'Intro' },
        { file: 'videos/diabetes.mp4', id: 'diabetes', title: 'Diabetes' }
    ]
};

/**
 * Moves the mock clock on, then lets the work it started run.
 *
 * @param {number} ms - How far.
 * @returns {Promise<void>}
 */
async function advance(ms: number): Promise<void> {
    mock.timers.tick(ms);
    for (let i = 0; i < 20; i++) {
        await nextTurn();
    }
}

describe('choosing a patient\'s waiting video, through the coordinator service', () => {
    let rooms: { name: string; occupants: unknown[]; }[];
    let played: { room: string; token: string; videoUrl: string; }[];
    let stopped: string[];
    let playing: string[];
    let service: CoordinatorService;
    let store: Store;

    const fake: IVideoPlayer = {
        play: async request => {
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
        store = new Store(mkdtempSync(join(tmpdir(), 'video-choice-')));
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
    const audit = () => service.audit(50).filter(e => e.kind === 'video');

    /**
     * Sees Sam in the lounge, then puts Sam in the patient's room, as the staff requests see it.
     *
     * @returns {Promise<void>}
     */
    async function samInPatientsRoom(): Promise<void> {
        rooms = [ { name: 'lounge-exam', occupants: [ doctor ] }, { name: 'HN/1', occupants: [ patient ] } ];
        await service.rooms();
        rooms = [ { name: 'HN/1', occupants: [ patient, doctor ] } ];
    }

    it('plays the encounter\'s choice for the current stage instead of the stage\'s default', async () => {
        const e = await startEncounter();

        assert.equal((await service.setVideo(e.id, 'waiting', 'diabetes', 'coord-1')).refused, undefined);
        assert.equal((await service.playVideo(e.id, 'coord-1')).video, 'diabetes');
        assert.equal(played[0].videoUrl, 'https://meet.example/videos/diabetes.mp4');
    });

    it('plays a video asked for before the choice, and a choice only at its own stage', async () => {
        const e = await startEncounter();

        await service.setVideo(e.id, 'waiting', 'diabetes', 'coord-1');
        assert.equal((await service.playVideo(e.id, 'coord-1', 'intro')).video, 'intro');
        await service.stopVideo(e.id, 'coord-1');

        await service.setVideo(e.id, 'billing', 'diabetes', 'coord-1');
        await service.changeStage(e.id, 'examination', 'coord-1');
        assert.equal((await service.playVideo(e.id, 'coord-1')).refused, 'no_video');
        await service.changeStage(e.id, 'billing', 'coord-1');
        assert.equal((await service.playVideo(e.id, 'coord-1')).video, 'diabetes');
    });

    it('refuses an unknown video, stage or encounter, and a closed encounter, and changes nothing', async () => {
        const e = await startEncounter();

        assert.equal((await service.setVideo(e.id, 'waiting', 'nope', 'coord-1')).refused, 'unknown_video');
        assert.equal((await service.setVideo(e.id, 'nonsense', 'diabetes', 'coord-1')).refused, 'stage_not_in_pathway');
        assert.equal((await service.setVideo('nope', 'waiting', 'diabetes', 'coord-1')).refused, 'unknown_encounter');
        assert.equal((await service.playVideo(e.id, 'coord-1')).video, 'intro');
        await service.changeStage(e.id, 'done', 'coord-1');
        assert.equal((await service.setVideo(e.id, 'waiting', 'diabetes', 'coord-1')).refused, 'encounter_closed');
    });

    it('audits every choice with who made it', async () => {
        const e = await startEncounter();

        await service.setVideo(e.id, 'waiting', 'diabetes', 'coord-1');
        await service.setVideo(e.id, 'waiting', 'nope', 'system');
        assert.deepEqual(audit().map(a => [ a.action, a.issuer, a.outcome, a.video, a.reason ]).reverse(), [
            [ 'choose', 'coord-1', 'ok', 'diabetes', undefined ],
            [ 'choose', 'system', 'refused', 'nope', 'unknown_video' ]
        ]);
    });

    it('keeps the choice in the store, which a restart reads', async () => {
        const e = await startEncounter();

        await service.setVideo(e.id, 'waiting', 'diabetes', 'coord-1');
        assert.deepEqual(store.load().encounters[0].videos, { waiting: 'diabetes' });
    });

    it('lets staff in the patient\'s room choose, play and stop, and audits them by name', async () => {
        const e = await startEncounter();

        await samInPatientsRoom();
        assert.equal((await service.staffSetVideo(e.id, 'waiting', 'diabetes', SAM)).refused, undefined);
        assert.equal((await service.staffPlayVideo(e.id, SAM)).video, 'diabetes');
        assert.equal((await service.staffStopVideo(e.id, SAM)).refused, undefined);
        assert.deepEqual(audit().map(a => [ a.action, a.issuer, a.outcome ]).reverse(),
            [ [ 'choose', 's-1', 'ok' ], [ 'play', 's-1', 'ok' ], [ 'stop', 's-1', 'ok' ] ]);
    });

    it('tells staff in the room the catalogue, the video chosen for the stage and whether one plays', async () => {
        const e = await startEncounter();

        await samInPatientsRoom();
        assert.deepEqual(await service.staffContext(SAM).then(c => [ c.videos?.map(v => v.id), c.chosenVideo, c.videoPlaying ]),
            [ [ 'intro', 'diabetes' ], 'intro', false ]);
        await service.staffSetVideo(e.id, 'waiting', 'diabetes', SAM);
        await service.staffPlayVideo(e.id, SAM);
        assert.deepEqual(await service.staffContext(SAM).then(c => [ c.chosenVideo, c.videoPlaying ]), [ 'diabetes', true ]);
    });

    it('refuses staff who are not in the patient\'s room, and does nothing', async () => {
        const e = await startEncounter();

        rooms = [ { name: 'lounge-exam', occupants: [ doctor ] }, { name: 'HN/1', occupants: [ patient ] } ];
        await service.rooms();
        assert.equal((await service.staffSetVideo(e.id, 'waiting', 'diabetes', SAM)).refused, 'not_in_patients_room');
        assert.equal((await service.staffPlayVideo(e.id, SAM)).refused, 'not_in_patients_room');
        assert.equal((await service.staffStopVideo(e.id, SAM)).refused, 'not_in_patients_room');
        assert.deepEqual(played, []);
        assert.deepEqual(audit().map(a => [ a.issuer, a.outcome, a.reason ]),
            Array(3).fill([ 's-1', 'refused', 'not_in_patients_room' ]));
    });

    it('keeps a video staff started from inside the room playing after they leave', async () => {
        const e = await startEncounter();

        await samInPatientsRoom();
        await service.staffPlayVideo(e.id, SAM);
        rooms = [ { name: 'lounge-exam', occupants: [ doctor ] }, { name: 'HN/1', occupants: [ patient ] } ];
        await advance(2000);
        assert.deepEqual(stopped, []);
        assert.equal(service.playingVideos().length, 1);
    });
});
