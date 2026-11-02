import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { describeRooms, parseRoleMarker } from '../src/rooms.ts';

const markers = {
    patient: parseRoleMarker('user.hospital_role=patient', 'X'),
    staff: parseRoleMarker('user.hospital_role=staff', 'X')
};

describe('describing the rooms Prosody reports', () => {
    const raw = {
        rooms: [ {
            name: 'hn%2fa1',
            occupants: [
                { displayName: 'P', endpointId: 'e1', hidden: false, identity: { user: { hospital_role: 'patient', id: 'p-1', name: 'Pat' } } },
                { cancelledMove: 'm-1', displayName: 'S', endpointId: 'e2', hidden: false, identity: { user: { hospital_role: 'staff', id: 's-1', name: 'Sam' } }, supportsMove: true },
                { displayName: 'bot', endpointId: 'e3', hidden: true },
                { displayName: 'X', endpointId: 'e4', hidden: false }
            ]
        } ]
    };

    it('gives each occupant a role from the role markers, and never calls the hidden bot a patient or staff', () => {
        const [ room ] = describeRooms(raw, markers);

        assert.deepEqual(room.occupants.map(o => [ o.endpointId, o.role ]), [
            [ 'e1', 'patient' ], [ 'e2', 'staff' ], [ 'e3', 'hidden' ], [ 'e4', 'unknown' ]
        ]);
    });

    it('carries the verified identity of an occupant that has one', () => {
        const [ room ] = describeRooms(raw, markers);

        assert.deepEqual(room.occupants[0].identity, { id: 'p-1', name: 'Pat' });
        assert.equal(room.occupants[3].identity, undefined);
    });

    it('reports whether an occupant supports moves and which move they cancelled', () => {
        const [ room ] = describeRooms(raw, markers);

        assert.equal(room.occupants[1].cancelledMove, 'm-1');
        assert.equal(room.occupants[1].supportsMove, true);
        assert.equal(room.occupants[0].cancelledMove, undefined);
        assert.equal(room.occupants[0].supportsMove, false);
    });

    it('decodes the room name, which Jitsi percent-encodes in the room address', () => {
        assert.equal(describeRooms(raw, markers)[0].name, 'hn/a1');
    });

    it('keeps a room name that is not valid percent-encoding as it is', () => {
        assert.equal(describeRooms({ rooms: [ { name: '100%', occupants: [] } ] }, markers)[0].name, '100%');
    });

    it('treats everyone as unknown when no role marker is configured', () => {
        const [ room ] = describeRooms(raw, {});

        assert.deepEqual(room.occupants.map(o => o.role), [ 'unknown', 'unknown', 'hidden', 'unknown' ]);
    });

    it('lists no rooms for an empty answer', () => {
        assert.deepEqual(describeRooms({}, markers), []);
        assert.deepEqual(describeRooms({ rooms: {} }, markers), []);
    });
});

describe('labelling the rooms from the configured layout', () => {
    const layout = {
        lounges: [ { room: 'Lounge-1' } ],
        stations: [ { room: 'intake-1', stage: 'intake' as const }, { room: 'aftercare-1', stage: 'aftercare' as const } ]
    };
    const raw = {
        rooms: [
            { name: 'intake-1', occupants: [ { endpointId: 'e1', hidden: false } ] },
            { name: 'hn%2fa1', occupants: [] }
        ]
    };

    it('labels a configured station with its stage and any other room as a patient\'s', () => {
        const rooms = describeRooms(raw, {}, layout);

        assert.deepEqual(rooms.map(r => [ r.name, r.kind, r.stage ]), [
            [ 'intake-1', 'station', 'intake' ],
            [ 'hn/a1', 'patient', undefined ],
            [ 'aftercare-1', 'station', 'aftercare' ],
            [ 'Lounge-1', 'lounge', undefined ]
        ]);
    });

    it('lists the configured rooms nobody is in as closed', () => {
        const rooms = describeRooms(raw, {}, layout);

        assert.deepEqual(rooms.map(r => r.open), [ true, true, false, false ]);
    });

    it('matches a configured room by the name Prosody gives it, whatever the case', () => {
        const [ lounge ] = describeRooms({ rooms: [ { name: 'lounge-1', occupants: [] } ] }, {}, layout)
            .filter(r => r.kind === 'lounge');

        assert.equal(lounge.open, true);
    });
});
