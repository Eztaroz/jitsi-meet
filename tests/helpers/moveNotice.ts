import type { Participant } from './Participant';

/**
 * Cancels the move a participant is counting down to, in one step in the page: the countdown lasts five seconds, and
 * on a loaded machine a separate lookup and click can take longer than that.
 *
 * @param {Participant} participant - The participant being moved.
 * @param {number} timeout - How long to wait for the notice, in milliseconds.
 * @returns {Promise<void>}
 */
export async function cancelMoveNotice(participant: Participant, timeout = 15_000): Promise<void> {
    await participant.driver.waitUntil(() => participant.driver.execute(() => {
        const button = document.getElementById('coordinator-move-cancel');

        button?.click();

        return Boolean(button);
    }), { interval: 100, timeout, timeoutMsg: 'there was no move notice to cancel' });
}
