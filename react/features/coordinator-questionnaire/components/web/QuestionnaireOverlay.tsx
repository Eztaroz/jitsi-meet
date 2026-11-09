import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import Button from '../../../base/ui/components/web/Button';
import { fetchPending, sendAnswers } from '../../functions.web';
import { IPendingQuestionnaire } from '../../types';

import ChoiceButton from './ChoiceButton';

/** How often the coordinator service is asked whether a questionnaire is waiting, in milliseconds. */
const POLL_MS = 3000;

const useStyles = makeStyles()(theme => {
    return {
        backdrop: {
            alignItems: 'center',
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            inset: 0,
            justifyContent: 'center',
            overflowY: 'auto',
            padding: theme.spacing(3),
            position: 'fixed',
            zIndex: 399
        },
        dialog: {
            backgroundColor: theme.palette.ui01,
            border: `1px solid ${theme.palette.ui03}`,
            borderRadius: '16px',
            boxSizing: 'border-box',
            color: theme.palette.text01,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing(3),
            maxHeight: '100%',
            maxWidth: '520px',
            overflowY: 'auto',
            padding: theme.spacing(4),
            width: '100%'
        },
        title: {
            fontSize: '20px',
            fontWeight: 600,
            lineHeight: '28px',
            margin: 0
        },
        question: {
            border: 0,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing(2),
            margin: 0,
            padding: 0
        },
        questionText: {
            fontSize: '16px',
            lineHeight: '24px',
            padding: 0
        },
        choices: {
            display: 'flex',
            gap: theme.spacing(2)
        },
        choice: {
            flex: 1
        }
    };
});

/**
 * Shows a patient the health questionnaire that staff or a coordinator sent them, in a dialog over the call and over
 * any waiting video, until they answer it or the coordinator service stops offering it because a staff member joined
 * the room after it was sent. It asks the service now and then, with the patient's own token. An unanswered
 * questionnaire holds nothing up.
 *
 * @returns {ReactElement|null}
 */
export default function QuestionnaireOverlay() {
    const { classes } = useStyles();
    const { t } = useTranslation();
    const jwt = useSelector((state: IReduxState) => state['features/base/jwt'].jwt);
    const [ pending, setPending ] = useState<IPendingQuestionnaire | undefined>();
    const [ chosen, setChosen ] = useState<number[]>([]);
    const [ sending, setSending ] = useState(false);
    const [ failed, setFailed ] = useState(false);

    const ask = useCallback(async () => {
        if (!jwt) {
            return false;
        }

        const next = await fetchPending(jwt);

        setPending(current => {
            if (current?.id !== next?.id) {
                setChosen([]);
                setFailed(false);
            }

            return next ?? undefined;
        });

        // Null: this token is not a patient's, so there is never anything to show.
        return next !== null;
    }, [ jwt ]);

    useEffect(() => {
        let timer: ReturnType<typeof setInterval> | undefined;

        ask().then(useful => {
            if (useful) {
                timer = setInterval(ask, POLL_MS);
            }
        });

        return () => clearInterval(timer);
    }, [ ask ]);

    const submit = useCallback(async () => {
        if (!jwt || !pending) {
            return;
        }
        setSending(true);
        setFailed(!await sendAnswers(jwt, pending.id, chosen));
        setSending(false);
        await ask();
    }, [ ask, chosen, jwt, pending ]);

    const choose = useCallback((question: number, choice: number) => {
        setChosen(current => {
            const copy = [ ...current ];

            copy[question] = choice;

            return copy;
        });
    }, []);

    if (!pending) {
        return null;
    }

    const complete = pending.questions.every((_, i) => chosen[i] === 0 || chosen[i] === 1);

    return (
        <div className = { classes.backdrop }>
            <div
                aria-labelledby = 'coordinator-questionnaire-title'
                aria-modal = 'true'
                className = { classes.dialog }
                id = 'coordinator-questionnaire'
                role = 'dialog'>
                <h2
                    className = { classes.title }
                    id = 'coordinator-questionnaire-title'>
                    { pending.title }
                </h2>
                { pending.questions.map((question, i) => (
                    <fieldset
                        className = { classes.question }
                        key = { i }>
                        <legend className = { classes.questionText }>{ question.text }</legend>
                        <div className = { classes.choices }>
                            { question.choices.map((choice, c) => (
                                <ChoiceButton
                                    choice = { choice }
                                    className = { classes.choice }
                                    index = { c }
                                    key = { c }
                                    onChoose = { choose }
                                    question = { i }
                                    selected = { chosen[i] === c } />
                            )) }
                        </div>
                    </fieldset>
                )) }
                { failed && <p role = 'alert'>{ t('coordinatorQuestionnaire.failed') }</p> }
                <Button
                    accessibilityLabel = { t('coordinatorQuestionnaire.submit') }
                    disabled = { !complete || sending }
                    fullWidth = { true }
                    id = 'coordinator-questionnaire-submit'
                    label = { t('coordinatorQuestionnaire.submit') }
                    onClick = { submit } />
            </div>
        </div>
    );
}
