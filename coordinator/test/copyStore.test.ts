import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';

import { copyStore } from '../src/copyStore.ts';
import { initialState, step } from '../src/rules.ts';
import { type IStore, newMoveRecord } from '../src/store.ts';

import { backends } from './storeBackends.ts';

const T0 = new Date('2030-01-01T08:00:00Z');
const databases = backends();

afterEach(() => databases[0].closeAll());

/**
 * Fills a store with one of everything the coordinator service keeps, and more than a batch of audit entries.
 *
 * @param {IStore} store - The store.
 * @returns {void}
 */
function fill(store: IStore): void {
    const a = step(initialState(), { at: T0, hn: 'A', type: 'start_encounter' });
    const b = step(a.state, { at: new Date(T0.getTime() + 500), hn: 'B', type: 'start_encounter' });
    const moved = step(b.state, {
        at: new Date(T0.getTime() + 1000), encounterId: a.encounter?.id as string, stage: 'intake', type: 'change_stage'
    });
    const move = {
        destination: 'b', endpointId: 'e', fromRoom: 'a', id: 'm-1', startedAt: T0, state: 'done', toRoom: 'b'
    } as never;
    const audit = Array.from({ length: 1200 }, (_, i) => ({
        at: new Date(T0.getTime() + i * 1000), encounterId: 'e', from: 'waiting' as const, issuer: 'system',
        kind: 'stage' as const, outcome: `ok-${i}`, to: 'intake' as const
    }));

    store.apply([
        ...moved.state.encounters.map(encounter => ({ encounter, kind: 'encounter' as const })),
        { kind: 'move', move, record: { ...newMoveRecord('coordinator-1'), audited: true, deadlines: { move_arrival: T0 } } },
        { consultation: { encounterId: 'e1', id: 'c1', recorderBot: 'bot-1', recording: false, startedAt: T0 }, kind: 'consultation' },
        { consultation: { encounterId: 'e2', id: 'c2', recorderBot: 'bot-2', recording: true, startedAt: T0 }, kind: 'consultation' },
        {
            consultation: { encounterId: 'e2', endedAt: new Date(T0.getTime() + 60_000), id: 'c3', recorderBot: 'bot-2', recording: true,
                startedAt: T0 },
            kind: 'consultation'
        },
        { identityId: 'p1', kind: 'patient_room', room: 'r1' },
        { identityId: 's1', kind: 'staff_station', station: 'intake' }
    ]);
    for (const entry of audit) {
        store.addAudit(entry);
    }
    store.addSurvey({
        aspects: { care: 5 }, comment: 'ok', encounterId: 'e1', hn: 'A', hnSource: 'known', id: 's-1', rating: 5, room: 'own_room',
        stage: 'examination', submittedAt: T0, tags: [ 'kind' ]
    });
}

for (const backend of databases) {
    describe(`copying a deployment's SQLite file into ${backend.name}`, () => {
        it('moves every encounter, move, audit entry, survey and consultation', async () => {
            const [ source, target ] = [ (await databases[0].fresh())(), (await backend.fresh())() ];

            fill(source);

            const counts = copyStore(source, target);

            assert.deepEqual(target.load().encounters, source.load().encounters);
            assert.deepEqual(target.load().moves, source.load().moves);
            assert.deepEqual(target.loadMoveRecords(), source.loadMoveRecords());
            assert.deepEqual(target.audit(10_000), source.audit(10_000));
            assert.equal(target.audit(10_000).length, 1200);
            assert.deepEqual(target.surveys(new Date(0), new Date('2100-01-01')), source.surveys(new Date(0), new Date('2100-01-01')));
            assert.deepEqual(target.allConsultations(), source.allConsultations());
            assert.equal(target.allConsultations().length, 3);
            assert.deepEqual(target.allConsultations().find(c => c.id === 'c3')?.endedAt, new Date(T0.getTime() + 60_000));
            assert.deepEqual(target.patientRooms(), { p1: 'r1' });
            assert.deepEqual(target.staffStations(), { s1: 'intake' });
            assert.deepEqual(counts, { audit: 1200, consultations: 3, encounters: 2, moves: 1, surveys: 1 });
        });

        it('refuses a database that already holds something, and changes nothing', async () => {
            const [ source, target ] = [ (await databases[0].fresh())(), (await backend.fresh())() ];

            fill(source);
            copyStore(source, target);

            assert.throws(() => copyStore(source, target), /already holds/u);
            assert.equal(target.audit(10_000).length, 1200);
        });
    });
}
