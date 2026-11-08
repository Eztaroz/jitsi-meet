// The page a participant lands on once they have left a room (static/left.html), when the deployment has neither a
// close page nor the welcome page. It shows the "leftPage" texts of lang/main-<language>.json, in the language the
// meeting had (the "lang" hash parameter), and offers to rejoin the room with the URL the meeting kept in session
// storage, unless the meeting was ended for everyone (the "ended" hash parameter). static/left-survey.js adds the
// satisfaction survey below it.

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
 * Reads a parameter of the hash, such as "th" for "lang" in "#lang=th&ended=true".
 *
 * @param {string} name - The parameter.
 * @returns {string|undefined}
 */
function getHashParam(name) {
    return new URLSearchParams(window.location.hash.slice(1)).get(name) ?? undefined;
}

/**
 * Fetches a translation file.
 *
 * @param {string} file - Its name, such as "main-th.json".
 * @returns {Promise<Object>} Its texts, or nothing when it cannot be fetched.
 */
async function fetchTexts(file) {
    try {
        const response = await fetch(`lang/${file}`);

        return response.ok ? await response.json() : {};
    } catch (error) {
        return {};
    }
}

/**
 * Loads the page's texts: English, with the meeting's language over it.
 *
 * @param {string|undefined} language - The meeting's language.
 * @returns {Promise<Object>} The "leftPage" and "leftSurvey" texts.
 */
async function loadTexts(language) {
    const [ english, translated ] = await Promise.all([
        fetchTexts('main.json'),
        /^[A-Za-z-]+$/.test(language ?? '') && language !== 'en' ? fetchTexts(`main-${language}.json`) : {}
    ]);

    return {
        leftPage: {
            ...english.leftPage,
            ...translated.leftPage
        },
        leftSurvey: {
            ...english.leftSurvey,
            ...translated.leftSurvey
        }
    };
}

const language = getHashParam('lang');

/** What static/left-survey.js shares with this page. */
window.leftPage = {
    ended: getHashParam('ended') === 'true',
    language,
    texts: loadTexts(language)
};

window.addEventListener('DOMContentLoaded', async () => {
    const { ended, texts } = window.leftPage;
    const rejoinUrl = ended ? undefined : getRejoinUrl();
    const rejoin = document.getElementById('left-rejoin');

    if (rejoinUrl && rejoin) {
        rejoin.hidden = false;
        rejoin.addEventListener('click', () => window.location.assign(rejoinUrl));
    }

    const { leftPage } = await texts;
    const shown = {
        hint: leftPage.hint,
        rejoin: leftPage.rejoin,
        title: ended ? leftPage.endedTitle : leftPage.title
    };

    if (language) {
        document.documentElement.lang = language;
    }
    Object.entries(shown).forEach(([ key, text ]) => {
        const element = document.getElementById(`left-${key}`);

        if (element && text) {
            element.textContent = text;
        }
    });
    document.title = document.getElementById('left-title')?.textContent ?? document.title;
});
