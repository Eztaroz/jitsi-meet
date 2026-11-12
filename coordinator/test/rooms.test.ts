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

    it('leaves out the rooms Jicofo opens for its own health check, which are nobody\'s', () => {
        const rooms = describeRooms({ rooms: [
            { name: '__jicofo-health-check-4904240162747317418', occupants: [] },
            { name: '__jicofo-health-check--3903072082638573757', occupants: [] },
            { name: 'hn%2fa1', occupants: [] }
        ] }, markers);

        assert.deepEqual(rooms.map(r => r.name), [ 'hn/a1' ]);
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
        centers: [ {
            id: 'center-1',
            stations: [
                { id: 'intake', lounge: 'lounge-intake', stage: 'intake' as const },
                { id: 'aftercare', lounge: 'Lounge-Aftercare', stage: 'aftercare' as const }
            ]
        } ]
    };
    const staff = { endpointId: 'e1', identity: { group: 'staff' } };
    const patient = { endpointId: 'e2', identity: { group: 'patient' } };
    const raw = {
        rooms: [
            { name: 'lounge-intake', occupants: [ staff ] },
            { name: 'hn%2fa1', occupants: [ patient, { ...staff, endpointId: 'e3' } ] }
        ]
    };
    const roles = {
        patient: { path: [ 'group' ] as [ 'group' ], value: 'patient' },
        staff: { path: [ 'group' ] as [ 'group' ], value: 'staff' }
    };

    it('labels a station\'s lounge with its station and stage, and any other room as a patient\'s', () => {
        const rooms = describeRooms(raw, roles, layout);

        assert.deepEqual(rooms.map(r => [ r.name, r.kind, r.station, r.stage ]), [
            [ 'lounge-intake', 'lounge', 'intake', 'intake' ],
            [ 'hn/a1', 'patient', undefined, undefined ],
            [ 'Lounge-Aftercare', 'lounge', 'aftercare', 'aftercare' ]
        ]);
    });

    it('gives the staff in a lounge its station, and nobody else', () => {
        const [ lounge, patientRoom ] = describeRooms(raw, roles, layout);

        assert.deepEqual(lounge.occupants.map(o => o.station), [ 'intake' ]);
        assert.deepEqual(patientRoom.occupants.map(o => o.station), [ undefined, undefined ]);
    });

    it('lists the lounges nobody is in as closed', () => {
        const rooms = describeRooms(raw, roles, layout);

        assert.deepEqual(rooms.map(r => r.open), [ true, true, false ]);
    });

    it('matches a lounge by the name Prosody gives it, whatever the case', () => {
        const lounges = describeRooms({ rooms: [ { name: 'lounge-aftercare', occupants: [] } ] }, {}, layout)
            .filter(r => r.kind === 'lounge');

        assert.deepEqual(lounges.map(r => [ r.station, r.open ]), [ [ 'aftercare', true ], [ 'intake', false ] ]);
    });
});
