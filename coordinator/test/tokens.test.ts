import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseRoleMarker } from '../src/rooms.ts';
import { destinationClaims } from '../src/tokens.ts';

const markers = {
    patient: parseRoleMarker('user.hospital_role=patient', 'X'),
    staff: parseRoleMarker('group=staff-group', 'X')
};
const now = new Date('2030-01-01T08:00:00Z');
const base = { audience: 'jitsi', issuer: 'coordinator', lifetimeMs: 120_000, markers, now, subject: 'meet.jitsi' };

describe('the token a moved participant gets for the destination', () => {
    it('names the destination room only, as Prosody names the room, with an expiry of a few minutes', () => {
        const claims = destinationClaims({ ...base, identity: { id: 'u-1', name: 'Sam' }, role: 'staff', room: 'Lounge/1' });

        assert.equal(claims.room, 'lounge%2f1');
        assert.equal(claims.exp, Math.floor(now.getTime() / 1000) + 120);
        assert.equal(claims.iss, 'coordinator');
        assert.equal(claims.aud, 'jitsi');
        assert.equal(claims.sub, 'meet.jitsi');
    });

    it('carries the participant\'s identity and the claim that marks their role', () => {
        const staff = destinationClaims({ ...base, identity: { id: 'u-1', name: 'Sam' }, role: 'staff', room: 'r' });
        const patient = destinationClaims({ ...base, identity: { id: 'p-1', name: 'Pat' }, role: 'patient', room: 'r' });

        assert.deepEqual(staff.context, { group: 'staff-group', user: { id: 'u-1', name: 'Sam' } });
        assert.deepEqual(patient.context, { user: { hospital_role: 'patient', id: 'p-1', name: 'Pat' } });
    });

    it('never grants the wildcard room', () => {
        assert.notEqual(destinationClaims({ ...base, identity: { id: 'u' }, role: 'staff', room: '*' }).room, '*');
    });
});
