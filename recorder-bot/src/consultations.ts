/**
 * The consultations this service knows about.
 */
import type { IConfig } from './config.ts';
import { Consultation } from './consultation.ts';
import { log } from './log.ts';
import { roomNameFromHn } from './roomName.ts';

/** The service already runs as many consultations as it may. */
export class AtCapacityError extends Error {}

export class Consultations {
    private readonly config: IConfig;
    private readonly byId = new Map<string, Consultation>();

    /**
     * Creates an empty registry.
     *
     * @param {IConfig} config - Service settings.
     */
    constructor(config: IConfig) {
        this.config = config;
    }

    /**
     * Starts recording a consultation for an HN, unless one is already running in that HN's room: then that one is
     * returned, so that a request can safely be repeated.
     *
     * With a station, it is the consultation of one patient in that station instead (ADR 0006). One is running per
     * HN and room together, so a patient's own room and a station can be recorded at the same time.
     *
     * @param {string} hn - The patient's HN.
     * @param {Object} station - Set for the consultation of one patient in a station.
     * @param {string} station.patientId - The patient's verified identity id.
     * @param {string} station.room - The station.
     * @returns {Object} The consultation, and whether it was started by this call.
     * @throws {AtCapacityError} When the service already runs as many consultations as it may.
     */
    start(hn: string, station?: { patientId: string; room: string; }): { consultation: Consultation; created: boolean; } {
        const room = roomNameFromHn(hn);
        const conferenceRoom = station ? roomNameFromHn(station.room) : room;
        const existing = this.running().find(c => c.room === room && c.conferenceRoom === conferenceRoom);

        if (existing) {
            log.info('consultation already running', { consultationId: existing.id });

            return { consultation: existing, created: false };
        }
        // A consultation still finalising counts: its browser may still be closing, and its files are remuxed.
        if (this.active().length >= this.config.maxConsultations) {
            log.warn('at capacity; consultation refused', { maxConsultations: this.config.maxConsultations });
            throw new AtCapacityError('at capacity');
        }

        const consultation = new Consultation(hn, this.config, station);

        this.byId.set(consultation.id, consultation);
        consultation.start();

        return { consultation, created: true };
    }

    /**
     * Looks a consultation up by id.
     *
     * @param {string} id - The consultation id.
     * @returns {Consultation|undefined}
     */
    get(id: string): Consultation | undefined {
        return this.byId.get(id);
    }

    /**
     * Returns the consultations that have not stopped yet. They count against the limit.
     *
     * @returns {Consultation[]}
     */
    running(): Consultation[] {
        return [ ...this.byId.values() ].filter(c => c.isRunning());
    }

    /**
     * Returns the consultations that have not reached a final status.
     *
     * @returns {Consultation[]}
     */
    active(): Consultation[] {
        return [ ...this.byId.values() ].filter(c => c.isActive());
    }

    /**
     * Stops every active consultation, for a service shutdown.
     *
     * @returns {Promise<void>}
     */
    async shutdown(): Promise<void> {
        await Promise.all(this.active().map(c => c.shutdown()));
    }
}
