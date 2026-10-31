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
     * @param {string} hn - The patient's HN.
     * @returns {Object} The consultation, and whether it was started by this call.
     * @throws {AtCapacityError} When the service already runs as many consultations as it may.
     */
    start(hn: string): { consultation: Consultation; created: boolean; } {
        const room = roomNameFromHn(hn);
        const running = this.running();
        const existing = running.find(c => c.room === room);

        if (existing) {
            log.info('consultation already running', { consultationId: existing.id });

            return { consultation: existing, created: false };
        }
        if (running.length >= this.config.maxConsultations) {
            log.warn('at capacity; consultation refused', { maxConsultations: this.config.maxConsultations });
            throw new AtCapacityError('at capacity');
        }

        const consultation = new Consultation(hn, this.config);

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
