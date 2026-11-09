import assert from 'node:assert/strict';
import { describe, test } from 'node:test';

import { parseRoleMarker, participantIdentity } from '../src/identity.ts';

const markers = {
    patient: parseRoleMarker('group=patient', 'PATIENT'),
    staff: parseRoleMarker('group=staff', 'STAFF'),
    videoPlayer: parseRoleMarker('group=video-player', 'VIDEO_PLAYER')
};

describe('the video player', () => {
    test('is recognised by its role marker, as neither staff nor patient', () => {
        const raw = { group: 'video-player', user: { id: 'video-player@hospital', name: 'Video' } };

        assert.deepEqual(participantIdentity(raw, markers), {
            identity: { id: 'video-player@hospital', name: 'Video' },
            role: 'video_player'
        });
    });

    test('is not recognised when no video player marker is configured', () => {
        const raw = { group: 'video-player', user: { id: 'video-player@hospital' } };

        assert.equal(participantIdentity(raw, { ...markers, videoPlayer: undefined }).role, 'unknown');
    });

    test('does not change how staff and patients are recognised', () => {
        assert.equal(participantIdentity({ group: 'staff', user: { id: 's' } }, markers).role, 'staff');
        assert.equal(participantIdentity({ group: 'patient', user: { id: 'p' } }, markers).role, 'patient');
    });

    test('a video player marker alone is enough to record identities', () => {
        const only = { videoPlayer: markers.videoPlayer };

        assert.equal(participantIdentity({ group: 'video-player', user: { id: 'v' } }, only).role, 'video_player');
    });
});
