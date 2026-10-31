/**
 * Runs a task now and then at every interval, never twice at once.
 */
import { errorCode, log } from './log.ts';

export class Periodic {
    private readonly intervalMs: number;
    private readonly name: string;
    private readonly task: () => Promise<void>;
    private running?: Promise<void>;
    private timer?: ReturnType<typeof setInterval>;

    /**
     * Creates a periodic task. Call {@link start} to start it.
     *
     * @param {string} name - What the task is, for the logs.
     * @param {Function} task - The task.
     * @param {number} intervalMs - How long to wait between runs, in milliseconds.
     */
    constructor(name: string, task: () => Promise<void>, intervalMs: number) {
        this.name = name;
        this.task = task;
        this.intervalMs = intervalMs;
    }

    /**
     * Runs the task now, then at every interval. A run that is due while the last one is still going is skipped.
     *
     * @returns {void}
     */
    start() {
        this.run();
        this.timer = setInterval(() => this.run(), this.intervalMs);
    }

    /**
     * Stops running the task, once the run under way, if any, is done.
     *
     * @returns {Promise<void>}
     */
    async stop(): Promise<void> {
        clearInterval(this.timer);
        await this.running;
    }

    /**
     * Runs the task, unless it is still running.
     *
     * @returns {void}
     */
    private run() {
        this.running ??= this.task()
            .catch(error => log.error('periodic task failed', { error: errorCode(error), task: this.name }))
            .finally(() => {
                this.running = undefined;
            });
    }
}
