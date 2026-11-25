/**
 * Today's figures of the coordinator screen: how the day is going, from the encounters and their histories. A day runs
 * from midnight to midnight in the deployment's time zone, as an NHSO bypass day does. An encounter the midnight close
 * ended was not finished: it is not done, and the stretch the close ended is not a wait.
 */
import { nextMidnight } from './midnight.ts';
import { DONE } from './pathways.ts';
import type { IEncounter } from './rules.ts';

export interface ITodayFigures {

    /** From start to done, over the encounters done today; none when none is done. */
    averageSeconds?: number;
    done: number;

    /** Each hour of the day from the first with a start or a done to the one it is now; none when nothing happened. */
    hours: { done: number; hour: number; started: number; }[];

    /** The longest single stretch in one stage that ended today or is still open, with when it began. */
    longest?: { seconds: number; since: Date; stage: string; };

    /** Each stage in order, with the average of its stretches that ended today; none when none did. */
    stages: { averageSeconds?: number; id: string; }[];
    started: number;
}

/**
 * The average of some durations, in whole seconds.
 *
 * @param {number[]} durations - In milliseconds.
 * @returns {number|undefined} Undefined when there are none.
 */
function averageSeconds(durations: number[]): number | undefined {
    return durations.length
        ? Math.round(durations.reduce((sum, d) => sum + d, 0) / durations.length / 1000)
        : undefined;
}

/**
 * Computes today's figures.
 *
 * @param {IEncounter[]} encounters - The encounters.
 * @param {Object} options - Options.
 * @param {string} options.clinic - Only this clinic's encounters; the whole center's without it.
 * @param {Date} options.now - When.
 * @param {string[]} options.stages - The ids of the configured stages, in order.
 * @param {string} options.timeZone - The deployment's IANA time zone.
 * @returns {ITodayFigures}
 */
export function todayFigures(encounters: readonly IEncounter[], { clinic, now, stages, timeZone }: {
    clinic?: string;
    now: Date;
    stages: readonly string[];
    timeZone: string;
}): ITodayFigures {
    const end = nextMidnight(now, timeZone).getTime();

    // The midnight after a day and a half before the day's end: the day's start, even across a change of clocks.
    const start = nextMidnight(new Date(end - 36 * 3600_000), timeZone).getTime();
    const isToday = (at: Date) => at.getTime() >= start && at.getTime() < end;

    const hourFormat = new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone });
    const hourOf = (at: Date) => Number(hourFormat.format(at));
    const startedIn: number[] = [];
    const doneIn: number[] = [];

    const totals: number[] = [];
    const ended = new Map<string, number[]>();
    let longest: { ms: number; since: Date; stage: string; } | undefined;
    let started = 0;

    for (const encounter of encounters) {
        if (clinic && encounter.clinic !== clinic) {
            continue;
        }
        if (isToday(encounter.startedAt)) {
            started++;
            startedIn.push(hourOf(encounter.startedAt));
        }
        for (const [ i, { at, stage } ] of encounter.history.entries()) {
            if (stage === DONE) {
                if (!encounter.unfinished && isToday(at)) {
                    totals.push(at.getTime() - encounter.startedAt.getTime());
                    doneIn.push(hourOf(at));
                }
                continue;
            }

            const next = encounter.history[i + 1];

            // The stretch the midnight close ended was nobody's wait.
            if (next && ((next.stage === DONE && encounter.unfinished) || !isToday(next.at))) {
                continue;
            }

            const ms = (next?.at ?? now).getTime() - at.getTime();

            if (next) {
                ended.set(stage, [ ...ended.get(stage) ?? [], ms ]);
            }
            if (!longest || ms > longest.ms) {
                longest = { ms, since: at, stage };
            }
        }
    }

    const active = [ ...startedIn, ...doneIn ];
    const first = Math.min(...active);
    const count = (hours: number[], hour: number) => hours.filter(h => h === hour).length;

    return {
        averageSeconds: averageSeconds(totals),
        done: totals.length,
        hours: active.length
            ? Array.from({ length: hourOf(now) - first + 1 }, (_, i) => ({
                done: count(doneIn, first + i),
                hour: first + i,
                started: count(startedIn, first + i)
            }))
            : [],
        longest: longest && { seconds: Math.round(longest.ms / 1000), since: longest.since, stage: longest.stage },
        stages: stages.filter(id => id !== DONE).map(id => ({ averageSeconds: averageSeconds(ended.get(id) ?? []), id })),
        started
    };
}
