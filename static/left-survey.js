// The satisfaction survey on the page a patient lands on once they have left a room (static/left.html): five faces
// to tap, then chips that depend on the rating, an optional rating of each part of the service, and suggestions. The
// answers go to the coordinator service (coordinator/src/surveyRoutes.ts) with the patient's own token, which the
// meeting kept in session storage; the service ties them to the patient's HN. The survey shows only when the service
// says this token may answer one: a staff member's does not.

(() => {
    /** The session storage key under which the meeting keeps the room left and the token (see actions.web.ts). */
    const SURVEY_KEY = 'leftPageSurvey';
    const SURVEY_URL = 'coordinator/survey';
    const LEVELS = [ 5, 4, 3, 2, 1 ];
    const ASPECTS = [ 'ease', 'quality', 'wait', 'care' ];
    const NEGATIVE_TAGS = [ 'picture', 'sound', 'wait', 'disconnected' ];
    const POSITIVE_TAGS = [ 'explained', 'kind' ];
    const FACE_COLOURS = [ '#e04757', '#f27a3a', '#f0b429', '#7cc36e', '#2ea36b' ];
    const ENTITIES = {
        '"': '&quot;',
        '&': '&amp;',
        '\'': '&#39;',
        '<': '&lt;',
        '>': '&gt;'
    };

    const answers = {
        aspects: {},
        comment: '',
        rating: undefined,
        tags: []
    };
    const view = {
        details: false,
        failed: false,
        sending: false
    };
    let texts = {};
    let root;

    /**
     * Escapes text for HTML.
     *
     * @param {unknown} value - The text.
     * @returns {string}
     */
    function esc(value) {
        return String(value ?? '').replace(/[&<>"']/g, c => ENTITIES[c]);
    }

    /**
     * Reads what the meeting kept for the survey.
     *
     * @returns {{room: string, token: string}|undefined}
     */
    function getHandoff() {
        try {
            const kept = JSON.parse(window.sessionStorage.getItem(SURVEY_KEY) ?? 'null');

            return typeof kept?.room === 'string' && typeof kept?.token === 'string' ? kept : undefined;
        } catch (error) {
            return undefined;
        }
    }

    /**
     * Forgets what the meeting kept for the survey, once it is answered or skipped.
     *
     * @returns {void}
     */
    function forgetHandoff() {
        try {
            window.sessionStorage.removeItem(SURVEY_KEY);
        } catch (error) {
            // Nothing to forget.
        }
    }

    /**
     * Draws a face, from 0 (very poor) to 4 (excellent).
     *
     * @param {number} index - Which face.
     * @returns {string} SVG.
     */
    function face(index) {
        const mouth = 15 + ((index - 2) * 3.2);

        return `<svg viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="11" fill="${FACE_COLOURS[index]}"/>
            <circle cx="8.5" cy="10" r="1.3" fill="#1e1e1e"/><circle cx="15.5" cy="10" r="1.3" fill="#1e1e1e"/>
            <path d="M7.5 15.01 Q12 ${mouth} 16.5 15" stroke="#1e1e1e" stroke-width="1.6" fill="none"
                stroke-linecap="round"/></svg>`;
    }

    /**
     * The chips offered for a rating: what went wrong for a poor one, what went well for a good one.
     *
     * @param {number} rating - The rating.
     * @returns {string[]}
     */
    function tagsFor(rating) {
        if (rating <= 2) {
            return NEGATIVE_TAGS;
        }

        return rating === 3 ? [ ...NEGATIVE_TAGS, ...POSITIVE_TAGS ] : POSITIVE_TAGS;
    }

    /**
     * One part of the service, rated from 5 to 1.
     *
     * @param {string} aspect - The part.
     * @returns {string}
     */
    function aspectRow(aspect) {
        const dots = LEVELS.map(level => {
            const on = answers.aspects[aspect] === level;

            return `<button type="button" role="radio" class="sv-dot${on ? ' is-on' : ''}" aria-checked="${on}"
                aria-label="${level} ${esc(texts.levels?.[level])}" data-aspect="${aspect}" data-level="${level}"
                ><i></i><em>${level}</em></button>`;
        });

        return `<div class="sv-aspect" role="radiogroup" aria-label="${esc(texts.aspects?.[aspect])}">
            <span class="sv-question">${esc(texts.aspects?.[aspect])}</span>
            <div class="sv-dots">${dots.join('')}</div>
        </div>`;
    }

    /**
     * The per-aspect rating, shown to whoever opens it.
     *
     * @returns {string}
     */
    function details() {
        if (!view.details) {
            return '';
        }

        return `<div class="sv-details" id="sv-details">
            <p class="sv-legend">5 = ${esc(texts.levels?.[5])} &middot; 1 = ${esc(texts.levels?.[1])}</p>
            ${ASPECTS.map(aspectRow).join('')}
        </div>`;
    }

    /**
     * What follows a rating: the chips, the per-aspect rating, the suggestions and the buttons.
     *
     * @returns {string}
     */
    function more() {
        if (answers.rating === undefined) {
            return `<button type="button" class="sv-link" data-action="skip">${esc(texts.skip)}</button>`;
        }

        const chips = tagsFor(answers.rating).map(tag => {
            const on = answers.tags.includes(tag);

            return `<button type="button" class="sv-chip${on ? ' is-on' : ''}" aria-pressed="${on}"
                data-tag="${tag}">${esc(texts.tags?.[tag])}</button>`;
        });

        return `<div class="sv-more">
            <p class="sv-label">${esc(texts.tagsTitle)}</p>
            <div class="sv-chips">${chips.join('')}</div>
            <button type="button" class="sv-toggle" aria-expanded="${view.details}" aria-controls="sv-details"
                data-action="details"><span>${esc(view.details ? texts.detailsHide : texts.detailsShow)}</span>
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"
                    stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round"/></svg></button>
            ${details()}
            <label class="sv-label" for="sv-comment">${esc(texts.commentLabel)}</label>
            <textarea id="sv-comment" class="sv-comment" rows="3" maxlength="2000"
                placeholder="${esc(texts.commentPlaceholder)}">${esc(answers.comment)}</textarea>
            ${view.failed ? `<p class="sv-error" role="alert">${esc(texts.sendFailed)}</p>` : ''}
            <div class="sv-row">
                <button type="button" class="sv-link" data-action="skip">${esc(texts.skip)}</button>
                <button type="button" class="sv-send" data-action="send"${view.sending ? ' disabled' : ''}
                    >${esc(texts.submit)}</button>
            </div>
        </div>`;
    }

    /**
     * Draws the survey.
     *
     * @returns {void}
     */
    function render() {
        const faces = [ 1, 2, 3, 4, 5 ].map(rating => {
            const on = answers.rating === rating;

            return `<button type="button" role="radio" class="sv-face${on ? ' is-on' : ''}" aria-checked="${on}"
                data-rating="${rating}">${face(rating - 1)}<span>${esc(texts.ratings?.[rating])}</span></button>`;
        });

        root.innerHTML = `<h2 class="sv-title" id="sv-title">${esc(texts.title)}</h2>
            <p class="sv-hint">${esc(texts.optional)}</p>
            <div class="sv-faces" role="radiogroup" aria-labelledby="sv-title">${faces.join('')}</div>
            ${more()}`;
    }

    /**
     * Thanks the patient once the answers are kept.
     *
     * @returns {void}
     */
    function thank() {
        root.innerHTML = `<div class="sv-thanks" role="status">
            <svg width="48" height="48" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="11"
                fill="rgba(46,163,107,.18)"/><path d="M7 12.5l3.2 3.2L17 9" stroke="#2ea36b" stroke-width="2.2"
                fill="none" stroke-linecap="round" stroke-linejoin="round"/></svg>
            <h2 class="sv-title">${esc(texts.thanks)}</h2><p class="sv-hint">${esc(texts.thanksHint)}</p></div>`;
    }

    /**
     * Sends the answers.
     *
     * @param {{room: string, token: string}} handoff - The room left and the patient's token.
     * @returns {Promise<void>}
     */
    async function send(handoff) {
        view.sending = true;
        view.failed = false;
        render();

        let status;

        try {
            const response = await fetch(SURVEY_URL, {
                body: JSON.stringify({
                    ...answers,
                    comment: answers.comment.trim() || undefined,
                    room: handoff.room
                }),
                headers: {
                    authorization: `Bearer ${handoff.token}`,
                    'content-type': 'application/json'
                },
                method: 'POST'
            });

            status = response.status;
        } catch (error) {
            status = undefined;
        }

        view.sending = false;

        // 429: these answers, or others just before them, are kept already.
        if (status === 201 || status === 429) {
            forgetHandoff();
            thank();
        } else {
            view.failed = true;
            render();
        }
    }

    /**
     * Applies a tap on the survey to the answers.
     *
     * @param {DOMStringMap} data - The tapped button's data attributes.
     * @returns {boolean} Whether the survey is to be drawn again.
     */
    function apply({ action, aspect, level, rating, tag }) {
        if (rating) {
            answers.rating = Number(rating);
            answers.tags = answers.tags.filter(t => tagsFor(answers.rating).includes(t));
        } else if (tag) {
            answers.tags = answers.tags.includes(tag) ? answers.tags.filter(t => t !== tag) : [ ...answers.tags, tag ];
        } else if (aspect) {
            answers.aspects = {
                ...answers.aspects,
                [aspect]: Number(level)
            };
        } else if (action === 'details') {
            view.details = !view.details;
        } else {
            return false;
        }

        return true;
    }

    /**
     * Handles a tap on the survey.
     *
     * @param {MouseEvent} event - The click.
     * @param {{room: string, token: string}} handoff - The room left and the patient's token.
     * @returns {void}
     */
    function onClick(event, handoff) {
        const button = event.target.closest('button');
        const data = button?.dataset ?? {};

        if (data.action === 'skip') {
            forgetHandoff();
            root.remove();
        } else if (data.action === 'send') {
            if (!view.sending) {
                send(handoff);
            }
        } else if (apply(data)) {
            const selector = Object.entries(data).map(([ key, value ]) => `[data-${key}="${value}"]`)
                .join('');

            render();

            // Drawing again loses the focus: give it back to the same button, for keyboards and screen readers.
            root.querySelector(selector)?.focus();
        }
    }

    /**
     * Asks the coordinator service whether this token may answer the survey.
     *
     * @param {string} token - The patient's token.
     * @returns {Promise<boolean>}
     */
    async function mayAsk(token) {
        try {
            return (await fetch(SURVEY_URL, { headers: { authorization: `Bearer ${token}` } })).ok;
        } catch (error) {
            return false;
        }
    }

    window.addEventListener('DOMContentLoaded', async () => {
        const handoff = getHandoff();
        const card = document.getElementById('left-page');

        if (!handoff || !card || !window.leftPage || !await mayAsk(handoff.token)) {
            return;
        }
        texts = (await window.leftPage.texts).leftSurvey;
        root = document.createElement('section');
        root.className = 'sv';
        root.id = 'left-survey';
        root.addEventListener('click', event => onClick(event, handoff));
        root.addEventListener('input', event => {
            if (event.target.id === 'sv-comment') {
                answers.comment = event.target.value;
            }
        });
        render();
        card.appendChild(root);
    });
})();
