/**
 * The consultations this service knows about.
 */
import type { IConfig } from './config.ts';
import { Consultation } from './consultation.ts';

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
     * Starts recording a consultation for an HN.
     *
     * @param {string} hn - The patient's HN.
     * @returns {Consultation}
     */
    start(hn: string): Consultation {
        const consultation = new Consultation(hn, this.config);

        this.byId.set(consultation.id, consultation);
        consultation.start();

        return consultation;
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
