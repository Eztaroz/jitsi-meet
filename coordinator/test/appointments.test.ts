import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import { CoordinatorService } from '../src/coordinatorService.ts';
import { APPOINTMENTS_SQL, type IAppointment, appointmentKey, appointmentsFrom } from '../src/his.ts';
import { localDate } from '../src/midnight.ts';
import type { Prosody } from '../src/prosody.ts';
import type { RecorderBot } from '../src/recorderBot.ts';
import { parseRoleMarker } from '../src/rooms.ts';
import { Store } from '../src/store.ts';

const { privateKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
    privateKeyEncoding: { format: 'pem', type: 'pkcs8' },
    publicKeyEncoding: { format: 'pem', type: 'spki' }
});

const staff = (id: string) => ({ endpointId: `e-${id}`, hidden: false, identity: { user: { hospital_role: 'staff', id } } });
const patient = (hn: string) =>
    ({ endpointId: `e-${hn}`, hidden: false, identity: { user: { hospital_role: 'patient', id: `p-${hn}` } } });
const TIME_ZONE = 'Asia/Bangkok';

describe('a patient who joins their room with an appointment today gets an encounter (ADR 0019)', () => {
    let asked: { date: string; hn: string; }[];
    let booked: Record<string, IAppointment[]>;
    let his: { appointments: (hn: string, date: string) => Promise<IAppointment[]>; };
    let record: () => Promise<string>;
    let rooms: { name: string; occupants: unknown[]; }[];
    let service: CoordinatorService;
    let store: Store;

    const today = () => localDate(new Date(), TIME_ZONE);
    const appointment = (clinicCode: string, time?: string, doctorCode = 101): IAppointment =>
        ({ clinicCode, date: today(), doctorCode, ...time ? { time } : {} });
    const open = (hn: string) => service.state.encounters.filter(e => e.hn === hn && e.stage !== 'done');

    beforeEach(() => {
        asked = [];
        booked = {};
        rooms = [];
        record = async () => 'c-1';
        his = {
            appointments: async (hn, date) => {
                asked.push({ date, hn });

                return booked[hn] ?? [];
            }
        };
        store = new Store(mkdtempSync(join(tmpdir(), 'appointments-')));
        service = new CoordinatorService({
            appointments: { appointments: (hn, date) => his.appointments(hn, date) },
            auditKey: 'audit-key',
            layout: {
                centers: [ {
                    clinics: [ { hisCodes: [ 'GYN', 'GY2' ], id: 'gyn', pathway: 'short' }, { hisCodes: [ 'MED' ], id: 'med' } ],
                    id: 'c1',
                    pathways: [ { id: 'short', stages: [
                        { id: 'waiting', name: 'Waiting' }, { id: 'examination', name: 'Examination' }, { id: 'done', name: 'Done' }
                    ] } ],
                    stations: [ { id: 'examination', lounge: 'lounge-exam', stages: [ 'examination' ] } ]
                } ]
            },
            prosody: { rooms: async () => ({ rooms }), sendMove: async () => undefined } as unknown as Prosody,
            recorderBot: { recordRoom: () => record() } as unknown as RecorderBot,
            retentionMs: 90 * 24 * 3600_000,
            retentionSweepMs: 3600_000,
            roleMarkers: {
                patient: parseRoleMarker('user.hospital_role=patient', 'X'),
                staff: parseRoleMarker('user.hospital_role=staff', 'X')
            },
            signingKey: { kid: 'k1', privateKey },
            store,
            timeZone: TIME_ZONE,
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });
    });

    afterEach(() => {
        service.stop();
        store.close();
    });

    it('starts the encounter in waiting, with the appointment as visit number and its clinic\'s pathway', async () => {
        booked['1234567'] = [ appointment('GY2', '09:30', 205) ];
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];

        await service.checkAppointments();

        const [ encounter ] = open('1234567');

        assert.equal(encounter.stage, 'waiting');
        assert.equal(encounter.visitNumber, `${today()}/GY2/205`);
        assert.equal(encounter.clinic, 'gyn');
        assert.equal(encounter.pathway, 'short');
        assert.deepEqual(asked, [ { date: today(), hn: '1234567' } ]);
        assert.equal((await service.rooms())[0].encounterId, encounter.id);
    });

    it('puts the patient in the queue, so staff can call them', async () => {
        booked['1234567'] = [ appointment('GYN', '09:30') ];
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];
        await service.checkAppointments();

        const id = open('1234567')[0].id;

        await service.changeStage(id, 'examination', 'coord-1');
        await service.setDoctor(id, 'd-1', 'coord-1');
        rooms.push({ name: 'lounge-exam', occupants: [ staff('d-1') ] });

        assert.equal((await service.staffCallNext({ id: 'd-1' })).encounterId, id);
    });

    it('follows the center\'s pathway for a clinic code no clinic has', async () => {
        booked['1234567'] = [ appointment('ENT', '10:00') ];
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];

        await service.checkAppointments();

        const [ encounter ] = open('1234567');

        assert.equal(encounter.clinic, undefined);
        assert.equal(encounter.pathway, 'default');
        assert.equal(encounter.visitNumber, `${today()}/ENT/101`);
    });

    it('starts nothing for a patient without an appointment today, and says so on their room', async () => {
        rooms = [ { name: '7654321', occupants: [ patient('7654321') ] } ];

        await service.checkAppointments();

        assert.deepEqual(open('7654321'), []);
        assert.equal((await service.rooms())[0].appointment, 'none');
    });

    it('does not ask the HIS again about a waiting patient within a minute', async () => {
        rooms = [ { name: '7654321', occupants: [ patient('7654321') ] } ];

        await service.checkAppointments();
        await service.checkAppointments();

        assert.equal(asked.length, 1);
    });

    it('asks again about a patient who left and came back', async () => {
        rooms = [ { name: '7654321', occupants: [ patient('7654321') ] } ];
        await service.checkAppointments();
        rooms = [];
        await service.checkAppointments();
        booked['7654321'] = [ appointment('MED', '13:00') ];
        rooms = [ { name: '7654321', occupants: [ patient('7654321') ] } ];

        await service.checkAppointments();

        assert.equal(asked.length, 2);
        assert.equal(open('7654321')[0].clinic, 'med');
    });

    it('takes the earliest of two clinics first, and the other once the first is done', async () => {
        booked['1234567'] = [ appointment('GYN', '08:00'), appointment('MED', '13:00') ];
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];
        await service.checkAppointments();

        const first = open('1234567')[0];

        assert.equal(first.clinic, 'gyn');
        await service.changeStage(first.id, 'done', 'coord-1');
        rooms = [];
        await service.checkAppointments();
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];
        await service.checkAppointments();

        const second = open('1234567')[0];

        assert.equal(second.clinic, 'med');
        assert.equal(second.visitNumber, `${today()}/MED/101`);
    });

    it('says every appointment of today has had its encounter, and starts none again', async () => {
        booked['1234567'] = [ appointment('GYN', '08:00') ];
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];
        await service.checkAppointments();
        await service.changeStage(open('1234567')[0].id, 'done', 'coord-1');
        rooms = [];
        await service.checkAppointments();
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];

        await service.checkAppointments();

        assert.deepEqual(open('1234567'), []);
        assert.equal((await service.rooms())[0].appointment, 'all_seen');
    });

    it('says the HIS could not be read, and starts nothing', async () => {
        his.appointments = async () => {
            throw new Error('connect ETIMEDOUT');
        };
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];

        await service.checkAppointments();

        assert.deepEqual(open('1234567'), []);
        assert.equal((await service.rooms())[0].appointment, 'unreadable');
    });

    it('leaves the room without an encounter when the recorder bot cannot take it, with no flag', async () => {
        booked['1234567'] = [ appointment('GYN', '08:00') ];
        record = async () => {
            throw new Error('at capacity');
        };
        rooms = [ { name: '1234567', occupants: [ patient('1234567') ] } ];

        await service.checkAppointments();

        assert.deepEqual(open('1234567'), []);
        assert.equal((await service.rooms())[0].appointment, undefined);
    });

    it('asks nothing about a room with no patient in it, a room with an encounter, or a lounge', async () => {
        await service.startEncounter('2222222');
        rooms = [
            { name: '1111111', occupants: [ staff('s-1') ] },
            { name: '2222222', occupants: [ patient('2222222') ] },
            { name: 'lounge-exam', occupants: [ staff('d-1') ] }
        ];

        await service.checkAppointments();

        assert.deepEqual(asked, []);
    });

    it('reads nothing when no HIS is configured', async () => {
        const plain = new CoordinatorService({
            auditKey: 'audit-key',
            layout: { centers: [] },
            prosody: { rooms: async () => ({ rooms: [ { name: '1234567', occupants: [ patient('1234567') ] } ] }) } as unknown as Prosody,
            recorderBot: { recordRoom: async () => 'c-1' } as unknown as RecorderBot,
            retentionMs: 1,
            retentionSweepMs: 3600_000,
            roleMarkers: { patient: parseRoleMarker('user.hospital_role=patient', 'X') },
            signingKey: { kid: 'k1', privateKey },
            store: new Store(mkdtempSync(join(tmpdir(), 'appointments-plain-'))),
            timeZone: 'UTC',
            token: { audience: 'jitsi', issuer: 'coordinator', subject: 'meet' }
        });

        await plain.checkAppointments();

        assert.deepEqual(plain.state.encounters, []);
        assert.equal((await plain.rooms())[0].appointment, undefined);
        plain.stop();
    });
});

describe('the HIS appointments lookup', () => {
    it('reads only the appointment\'s date, time, clinic and doctor, by HN and day', () => {
        assert.match(APPOINTMENTS_SQL, /^SELECT /u);
        assert.doesNotMatch(APPOINTMENTS_SQL, /PNAME|\*/u);
        assert.match(APPOINTMENTS_SQL, /WHERE HN = \? AND DATE_AP = \?/u);
    });

    it('turns rows into appointments, trimming the HIS\'s padded codes', () => {
        assert.deepEqual(appointmentsFrom([
            { c_doct: 205, code_ap: 'GY ', date_ap: '2026-11-25', time_ap: '09:30' },
            { c_doct: 7, code_ap: 'MED', date_ap: '2026-11-25', time_ap: '' }
        ]), [
            { clinicCode: 'GY', date: '2026-11-25', doctorCode: 205, time: '09:30' },
            { clinicCode: 'MED', date: '2026-11-25', doctorCode: 7 }
        ]);
    });

    it('keys an appointment by day, clinic and doctor, with no HN in it', () => {
        assert.equal(appointmentKey({ clinicCode: 'GYN', date: '2026-11-25', doctorCode: 205 }), '2026-11-25/GYN/205');
    });

    it('takes the day in the service\'s time zone', () => {
        assert.equal(localDate(new Date('2026-11-25T18:00:00Z'), 'Asia/Bangkok'), '2026-11-26');
        assert.equal(localDate(new Date('2026-11-25T16:59:59Z'), 'Asia/Bangkok'), '2026-11-25');
    });
});
