// The page a participant lands on once they have left a room (static/left.html), when the deployment has neither a
// close page nor the welcome page. It shows the "leftPage" texts of lang/main-<language>.json, in the language the
// meeting had (the "lang" hash parameter), and offers to rejoin the room with the URL the meeting kept in session
// storage.

/**
 * The session storage key under which the meeting keeps the URL that rejoins the room (see
 * react/features/app/actions.web.ts).
 */
const REJOIN_URL_KEY = 'leftPageRejoinUrl';

/**
 * Reads the URL that rejoins the room, if the meeting kept one and it is on this server.
 *
 * @returns {string|undefined}
 */
function getRejoinUrl() {
    try {
        const url = window.sessionStorage.getItem(REJOIN_URL_KEY);

        return url && new URL(url).origin === window.location.origin ? url : undefined;
    } catch (error) {
        return undefined;
    }
}

/**
 * Reads the meeting's language from the hash, such as "th" in "#lang=th".
 *
 * @returns {string|undefined}
 */
function getLanguage() {
    const match = window.location.hash.match(/(?:^#|&)lang=([A-Za-z-]+)(?:&|$)/);

    return match ? match[1] : undefined;
}

/**
 * Shows the page's texts in the meeting's language. English, in the page itself, stays when the language has no
 * translation file or it cannot be fetched.
 *
 * @param {string|undefined} language - The language.
 * @returns {Promise<void>}
 */
async function translate(language) {
    if (!language || language === 'en') {
        return;
    }

    try {
        const response = await fetch(`lang/main-${language}.json`);
        const texts = response.ok ? (await response.json()).leftPage : undefined;

        if (!texts) {
            return;
        }
        document.documentElement.lang = language;
        [ 'title', 'hint', 'rejoin' ].forEach(key => {
            const element = document.getElementById(`left-${key}`);

            if (element && texts[key]) {
                element.textContent = texts[key];
            }
        });
    } catch (error) {
        // The English texts stay.
    }
}

window.addEventListener('DOMContentLoaded', () => {
    const rejoinUrl = getRejoinUrl();
    const rejoin = document.getElementById('left-rejoin');

    if (rejoinUrl && rejoin) {
        rejoin.hidden = false;
        rejoin.addEventListener('click', () => window.location.assign(rejoinUrl));
    }
    translate(getLanguage()).then(() => {
        document.title = document.getElementById('left-title')?.textContent ?? document.title;
    });
});
