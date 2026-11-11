import fs from 'node:fs';
import path from 'node:path';

import { v4 as uuidv4 } from 'uuid';

import { Participant } from '../../helpers/Participant';
import { setTestProperties } from '../../helpers/TestProperties';
import { config } from '../../helpers/TestsConfig';
import {
    callCoordinator,
    coordinatorUnavailableReason,
    getAudit,
    postEncounter
} from '../../helpers/coordinator';
import { expectations } from '../../helpers/expectations';
import { joinMuc } from '../../helpers/joinMuc';
import {
    type IManifest,
    type ITimelineEntry,
    docker,
    evidenceUnavailableReason,
    getHiddenIds,
    patientLinkRoom,
    uniqueHn,
    waitForHiddenParticipant,
    waitForNewBot
} from '../../helpers/recorderBot';
import { generateToken } from '../../helpers/token';

setTestProperties(__filename, {
    description: 'The recorder bot worker that records a consultation is cut off from the coordinator service (its \
container is paused, so that it sends no heartbeat). After 15 seconds the service hands the same consultation to the \
other recorder bot, which joins the room and records the rest. When the cut-off worker is resumed, the answer to its \
heartbeat tells it that the consultation was taken over, and it stops. The evidence recording has a folder for each \
part under the consultation\'s, a manifest that lists both, and a gap. Skipped unless the coordinator test deployment \
is up, with RECORDER_BOT_STORAGE_ROOT and COORDINATOR_WORKER_CONTAINERS set.',
    usesBrowsers: [ 'p1' ]
});

interface IConsultationInfo {
    id: string;
    recorderBot: string;
    recording: boolean;
    startedAt: string;
}

interface IConsultationManifest {
    consultationId: string;
    gaps: Array<{ end: string; start: string; }>;
    parts: Array<{ folder: string; part: string; }>;
}

/**
 * Reads which docker container each recorder bot worker runs in.
 *
 * @returns {Record<string, string>}
 */
function workerContainers(): Record<string, string> {
    return Object.fromEntries((config.coordinator.workerContainers ?? '').split(',').filter(Boolean)
        .map(pair => pair.split('=') as [ string, string ]));
}

/**
 * Reads the consultation of an encounter.
 *
 * @param {string} encounterId - The encounter.
 * @returns {Promise<IConsultationInfo>}
 */
async function consultationOf(encounterId: string): Promise<IConsultationInfo> {
    const response = await callCoordinator(`/encounters/${encounterId}/consultations`);

    return (await response.json() as { consultations: IConsultationInfo[]; }).consultations[0];
}

/**
 * Finds the consultation's folder in the evidence storage root, by its id in the manifest the parts add up to.
 *
 * @param {string} consultationId - The consultation.
 * @returns {string|undefined} Its location in the storage root.
 */
function findConsultationFolder(consultationId: string): string | undefined {
    const root = config.recorderBot.storageRoot ?? '';
    const folders = (dir: string) => fs.existsSync(dir)
        ? fs.readdirSync(dir, { withFileTypes: true }).filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name)
        : [];

    for (const patient of folders(root)) {
        for (const start of folders(path.join(root, patient))) {
            try {
                const manifest = JSON.parse(
                    fs.readFileSync(path.join(root, patient, start, 'manifest.json'), 'utf8')) as IConsultationManifest;

                if (manifest.consultationId === consultationId) {
                    return path.join(patient, start);
                }
            } catch {
                // Not a consultation's folder, or not finished.
            }
        }
    }

    return undefined;
}

describe('Coordinator: a lost recorder bot\'s consultation is taken over', () => {
    let hn: string;
    let encounterId: string;
    let patient: Participant;
    let first: IConsultationInfo;
    let paused: string | undefined;

    after(() => {
        // Whatever failed, the worker must not stay paused for the specs that follow.
        if (paused) {
            docker('unpause', paused);
        }
    });

    it('setup', async () => {
        const unavailable = coordinatorUnavailableReason() ?? evidenceUnavailableReason();

        if (unavailable || Object.keys(workerContainers()).length < 2) {
            ctx.skipSuiteTests = unavailable ?? 'COORDINATOR_WORKER_CONTAINERS is not set';

            return;
        }

        hn = uniqueHn('TAKE');
    });

    it('records the patient\'s room with one of the recorder bots', async () => {
        const { body, status } = await postEncounter(hn);

        expect(status).toBe(201);
        encounterId = body.id;
        first = await consultationOf(encounterId);
        expect(first.recording).toBe(true);
        expect(Object.keys(workerContainers())).toContain(first.recorderBot);

        patient = await joinMuc({
            name: 'p1',
            token: generateToken({
                displayName: 'Patient P',
                userClaims: { ...expectations.recorderBot.patientClaims, id: `patient-${uuidv4()}` }
            })
        }, { roomName: patientLinkRoom(hn) });
        await waitForHiddenParticipant(patient);
    });

    it('hands the same consultation to the other recorder bot once the worker is lost', async () => {
        const before = await getHiddenIds(patient);

        paused = workerContainers()[first.recorderBot];
        docker('pause', paused);

        // Lost after 15 seconds without a heartbeat, and the service checks every 5.
        await patient.driver.waitUntil(async () => {
            const now = await consultationOf(encounterId);

            return now.recorderBot !== first.recorderBot && now.recording;
        }, { timeout: 60_000, timeoutMsg: 'the consultation was not taken over' });

        const taken = await consultationOf(encounterId);

        expect(taken.id).toBe(first.id);
        expect(taken.startedAt).toBe(first.startedAt);
        await waitForNewBot(patient, before);
    });

    it('tells the cut-off worker, when it is back, that its consultation was taken over', async () => {
        docker('unpause', paused ?? '');
        paused = undefined;

        // The worker's heartbeat is answered with the consultations taken over, and its recorder bot stops.
        await patient.driver.pause(10_000);
    });

    it('keeps each part in a folder of its own, with a manifest that lists both and the gap', async () => {
        await patient.hangup();

        let folder: string | undefined;

        await patient.driver.waitUntil(() => {
            folder = findConsultationFolder(first.id);

            return Boolean(folder)
                && (JSON.parse(fs.readFileSync(path.join(config.recorderBot.storageRoot ?? '', folder ?? '', 'manifest.json'),
                    'utf8')) as IConsultationManifest).parts.length === 2;
        }, { timeout: 120_000, timeoutMsg: 'the evidence recording does not list both parts' });

        const root = path.join(config.recorderBot.storageRoot ?? '', folder ?? '');
        const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8')) as IConsultationManifest;
        const taker = (await consultationOf(encounterId)).recorderBot;

        expect(manifest.parts.map(p => p.part).sort()).toEqual(Object.keys(workerContainers()).sort());
        expect(manifest.gaps.length).toBeGreaterThan(0);

        const part = JSON.parse(fs.readFileSync(path.join(root, taker, 'manifest.json'), 'utf8')) as IManifest;
        const timeline = JSON.parse(fs.readFileSync(path.join(root, taker, 'timeline.json'), 'utf8')) as {
            entries: ITimelineEntry[];
        };

        expect(part.consultationId).toBe(first.id);
        expect(timeline.entries.some(e => e.type === 'gap')).toBe(true);
    });

    it('reports nothing as unrecorded while another recorder bot has room', async () => {
        const entries = await getAudit();

        expect(entries.some(e => e.kind === 'consultation_unrecorded')).toBe(false);
    });
});
