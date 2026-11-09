import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector, useStore } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import { getLocalParticipant, isPatientParticipant, isPatientsRoom } from '../../../base/participants/functions';
import Button from '../../../base/ui/components/web/Button';
import { changeStage, fetchQuestionnaires, fetchStaffContext, sendQuestionnaire } from '../../functions.web';
import { IStaffContext, IStaffQuestionnaire } from '../../types';

/** How often the staff member's place is asked again, in milliseconds. */
const REFRESH_MS = 3000;

const useStyles = makeStyles()(theme => {
    return {
        panel: {
            alignItems: 'center',
            backgroundColor: theme.palette.ui01,
            border: `1px solid ${theme.palette.ui03}`,
            borderRadius: '12px',
            boxShadow: '0 8px 24px rgba(0, 0, 0, 0.35)',
            color: theme.palette.text01,
            display: 'flex',
            flexWrap: 'wrap',
            gap: theme.spacing(2),
            left: theme.spacing(3),
            padding: theme.spacing(2),
            position: 'fixed',
            top: theme.spacing(10),
            zIndex: 300
        },
        select: {
            backgroundColor: theme.palette.ui03,
            border: `1px solid ${theme.palette.ui04}`,
            borderRadius: '6px',
            color: theme.palette.text01,
            padding: theme.spacing(1)
        },
        answers: {
            flexBasis: '100%',
            maxHeight: '30vh',
            overflowY: 'auto'
        },
        error: {
            color: theme.palette.warning01,
            flexBasis: '100%'
        }
    };
});

/**
 * Shows a staff member, in a patient's own room, the patient's current stage and a picker of every other stage of the
 * pathway but done (ADR 0012). Changing the stage makes the service move the staff member back to their lounge. It
 * shows nothing to anyone the service does not take for staff.
 *
 * @returns {ReactElement|null}
 */
const StaffStagePanel = () => {
    const store = useStore<IReduxState>();
    const inPatientsRoom = useSelector((state: IReduxState) => isPatientsRoom(state)
        && !isPatientParticipant(state, getLocalParticipant(state)));
    const hasJwt = useSelector((state: IReduxState) => Boolean(state['features/base/jwt'].jwt));
    const [ context, setContext ] = useState<IStaffContext | undefined>();
    const [ chosen, setChosen ] = useState('');
    const [ error, setError ] = useState<string | undefined>();
    const [ chosenQuestionnaire, setChosenQuestionnaire ] = useState('');
    const [ questionnaireError, setQuestionnaireError ] = useState(false);
    const [ sentQuestionnaires, setSentQuestionnaires ] = useState<IStaffQuestionnaire[]>([]);
    const { t } = useTranslation();
    const { classes } = useStyles();

    useEffect(() => {
        if (!inPatientsRoom || !hasJwt) {
            setContext(undefined);

            return;
        }

        let cancelled = false;
        const refresh = async () => {
            const fresh = await fetchStaffContext(store.getState());

            const answers = fresh?.encounter ? await fetchQuestionnaires(store.getState(), fresh.encounter.id) : undefined;

            if (!cancelled) {
                setContext(fresh);
                setSentQuestionnaires(answers ?? []);
            }
        };

        refresh();

        const timer = setInterval(refresh, REFRESH_MS);

        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [ inPatientsRoom, hasJwt, store ]);

    const onChange = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => setChosen(event.target.value), []);
    const onApply = useCallback(async () => {
        if (!context?.encounter || !chosen) {
            return;
        }
        setError(await changeStage(store.getState(), context.encounter.id, chosen));
    }, [ chosen, context, store ]);

    const onPickQuestionnaire = useCallback((event: React.ChangeEvent<HTMLSelectElement>) =>
        setChosenQuestionnaire(event.target.value), []);
    const onSendQuestionnaire = useCallback(async () => {
        if (!context?.encounter || !chosenQuestionnaire) {
            return;
        }
        setQuestionnaireError(Boolean(await sendQuestionnaire(store.getState(), context.encounter.id, chosenQuestionnaire)));
    }, [ chosenQuestionnaire, context, store ]);

    if (context?.where !== 'patients_room' || !context.encounter) {
        return null;
    }

    return (
        <div
            className = { classes.panel }
            id = 'staff-stage-panel'>
            <span id = 'staff-current-stage'>
                { t('staffActions.currentStage', { stage: context.encounter.stageName }) }
            </span>
            <select
                aria-label = { t('staffActions.pickStage') }
                className = { classes.select }
                id = 'staff-stage-picker'
                onChange = { onChange }
                value = { chosen }>
                <option value = ''>{ t('staffActions.pickStage') }</option>
                { context.stages?.map(stage => (
                    <option
                        key = { stage.id }
                        value = { stage.id }>
                        { stage.name }
                    </option>
                )) }
            </select>
            <Button
                accessibilityLabel = { t('staffActions.apply') }
                disabled = { !chosen }
                id = 'staff-stage-apply'
                labelKey = 'staffActions.apply'
                onClick = { onApply } />
            { error && <span className = { classes.error }>{ t('staffActions.refused') }</span> }
            { Boolean(context.questionnaires?.length) && (
                <>
                    <select
                        aria-label = { t('staffActions.pickQuestionnaire') }
                        className = { classes.select }
                        id = 'staff-questionnaire-picker'
                        onChange = { onPickQuestionnaire }
                        value = { chosenQuestionnaire }>
                        <option value = ''>{ t('staffActions.pickQuestionnaire') }</option>
                        { context.questionnaires?.map(questionnaire => (
                            <option
                                key = { questionnaire.id }
                                value = { questionnaire.id }>
                                { questionnaire.title }
                            </option>
                        )) }
                    </select>
                    <Button
                        accessibilityLabel = { t('staffActions.sendQuestionnaire') }
                        disabled = { !chosenQuestionnaire }
                        id = 'staff-questionnaire-send'
                        labelKey = 'staffActions.sendQuestionnaire'
                        onClick = { onSendQuestionnaire } />
                </>
            ) }
            { questionnaireError
                && <span className = { classes.error }>{ t('staffActions.questionnaireNotSent') }</span> }
            { sentQuestionnaires.length > 0 && (
                <div
                    className = { classes.answers }
                    id = 'staff-questionnaire-answers'>
                    { sentQuestionnaires.map(sent => (
                        <div
                            className = 'staff-questionnaire'
                            key = { sent.id }>
                            <strong>{ sent.title }</strong>
                            { sent.answers
                                ? sent.questions.map((question, index) => (
                                    <div key = { index }>
                                        { t('staffActions.answer', {
                                            choice: question.choices[sent.answers?.[index] ?? 0],
                                            question: question.text
                                        }) }
                                    </div>))
                                : <div>{ t('staffActions.noAnswersYet') }</div> }
                        </div>)) }
                </div>
            ) }
        </div>
    );
};

export default StaffStagePanel;
