/**
 * The time of the next midnight in a time zone: when the encounters still open are closed.
 */

/**
 * Returns how far a time zone is ahead of UTC at a moment, in milliseconds.
 *
 * @param {Date} date - The moment.
 * @param {string} timeZone - An IANA time zone.
 * @returns {number}
 */
function offsetMs(date: Date, timeZone: string): number {
    const parts = Object.fromEntries(new Intl.DateTimeFormat('en-US', {
        day: 'numeric',
        hour: 'numeric',
        hourCycle: 'h23',
        minute: 'numeric',
        month: 'numeric',
        second: 'numeric',
        timeZone,
        year: 'numeric'
    }).formatToParts(date).map(p => [ p.type, Number(p.value) ]));

    return Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour, parts.minute, parts.second)
        - Math.floor(date.getTime() / 1000) * 1000;
}

/**
 * Returns the next midnight in a time zone, after a moment. At midnight exactly, it is the one after.
 *
 * @param {Date} now - The moment.
 * @param {string} timeZone - An IANA time zone; UTC by default.
 * @returns {Date}
 */
export function nextMidnight(now: Date, timeZone = 'UTC'): Date {
    const local = new Date(now.getTime() + offsetMs(now, timeZone));
    const wanted = Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + 1);

    // The offset can differ at midnight from now (daylight saving time), so take it where midnight falls.
    let candidate = wanted - offsetMs(new Date(wanted - offsetMs(now, timeZone)), timeZone);

    candidate = wanted - offsetMs(new Date(candidate), timeZone);

    return new Date(candidate);
}
