import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector, useStore } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import { getLocalParticipant, isPatientParticipant, isPatientsRoom } from '../../../base/participants/functions';
import Button from '../../../base/ui/components/web/Button';
import { changeStage, chooseVideo, fetchStaffContext, playVideo, stopVideo } from '../../functions.web';
import { IStaffContext } from '../../types';

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
        row: {
            alignItems: 'center',
            display: 'flex',
            flexBasis: '100%',
            flexWrap: 'wrap',
            gap: theme.spacing(2)
        },
        select: {
            backgroundColor: theme.palette.ui03,
            border: `1px solid ${theme.palette.ui04}`,
            borderRadius: '6px',
            color: theme.palette.text01,
            padding: theme.spacing(1)
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

            if (!cancelled) {
                setContext(fresh);
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

    /**
     * Sends a video request, shows why it was refused, and asks where the staff member is again at once.
     *
     * @param {Function} request - The request.
     * @returns {Promise<void>}
     */
    const runVideo = useCallback(async (request: (encounterId: string) => Promise<string | undefined>) => {
        if (!context?.encounter) {
            return;
        }
        setError(await request(context.encounter.id));
        setContext(await fetchStaffContext(store.getState()));
    }, [ context, store ]);
    const onChooseVideo = useCallback((event: React.ChangeEvent<HTMLSelectElement>) => {
        const video = event.target.value;

        runVideo(id => chooseVideo(store.getState(), id, context?.encounter?.stage ?? '', video));
    }, [ context, runVideo, store ]);
    const onPlayVideo = useCallback(() => {
        runVideo(id => playVideo(store.getState(), id));
    }, [ runVideo, store ]);
    const onStopVideo = useCallback(() => {
        runVideo(id => stopVideo(store.getState(), id));
    }, [ runVideo, store ]);

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
            { Boolean(context.videos?.length) && (
                <div
                    className = { classes.row }
                    id = 'staff-video-controls'>
                    <select
                        aria-label = { t('staffActions.pickVideo') }
                        className = { classes.select }
                        id = 'staff-video-picker'
                        onChange = { onChooseVideo }
                        value = { context.chosenVideo ?? '' }>
                        <option
                            disabled = { true }
                            value = ''>
                            { t('staffActions.pickVideo') }
                        </option>
                        { context.videos?.map(video => (
                            <option
                                key = { video.id }
                                value = { video.id }>
                                { video.title }
                            </option>
                        )) }
                    </select>
                    <Button
                        accessibilityLabel = { t('staffActions.playVideo') }
                        disabled = { context.videoPlaying || !context.chosenVideo }
                        id = 'staff-video-play'
                        labelKey = 'staffActions.playVideo'
                        onClick = { onPlayVideo } />
                    <Button
                        accessibilityLabel = { t('staffActions.stopVideo') }
                        disabled = { !context.videoPlaying }
                        id = 'staff-video-stop'
                        labelKey = 'staffActions.stopVideo'
                        onClick = { onStopVideo } />
                </div>
            ) }
            { error && <span className = { classes.error }>{ t('staffActions.refused') }</span> }
        </div>
    );
};

export default StaffStagePanel;
