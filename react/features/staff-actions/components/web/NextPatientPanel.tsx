import React, { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import { isPatientsRoom } from '../../../base/participants/functions';
import { playSound, registerSound, unregisterSound } from '../../../base/sounds/actions';
import Button from '../../../base/ui/components/web/Button';
import { STAFF_QUEUE_SOUND_FILE, STAFF_QUEUE_SOUND_ID } from '../../constants';
import { callNextPatient, fetchStaffContext, isNewArrival, notifyInBackground } from '../../functions.web';
import { IStaffContext } from '../../types';

/**
 * Whether the browser can still ask the staff member to allow notifications.
 *
 * @returns {boolean}
 */
function canAskForNotifications(): boolean {
    return 'Notification' in window && Notification.permission === 'default';
}

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
        message: {
            flexBasis: '100%'
        },
        queue: {
            fontWeight: 600
        }
    };
});

/**
 * Shows a staff member, in a station's lounge, how many patients wait for their station and a "next patient" button
 * (ADR 0012). Pressing it makes the service move them to the longest-waiting patient of their station, or tells them
 * that the queue is empty. When a patient joins the queue, a knock plays and, with the page in the background and
 * notifications allowed, a browser notification shows (#24); neither names the patient. It shows nothing to anyone the
 * service does not take for staff in a lounge.
 *
 * @returns {ReactElement|null}
 */
const NextPatientPanel = () => {
    const store = useStore<IReduxState>();
    const dispatch = useDispatch();
    const outsidePatientsRoom = useSelector((state: IReduxState) => !isPatientsRoom(state));
    const hasJwt = useSelector((state: IReduxState) => Boolean(state['features/base/jwt'].jwt));
    const [ context, setContext ] = useState<IStaffContext | undefined>();
    const [ message, setMessage ] = useState<string | undefined>();
    const [ askNotifications, setAskNotifications ] = useState(canAskForNotifications);
    const lastQueue = useRef<IStaffContext['queue']>();
    const { t } = useTranslation();
    const { classes } = useStyles();

    useEffect(() => {
        dispatch(registerSound(STAFF_QUEUE_SOUND_ID, STAFF_QUEUE_SOUND_FILE));

        return () => {
            dispatch(unregisterSound(STAFF_QUEUE_SOUND_ID));
        };
    }, [ dispatch ]);

    useEffect(() => {
        if (!outsidePatientsRoom || !hasJwt) {
            setContext(undefined);
            lastQueue.current = undefined;

            return;
        }

        let cancelled = false;
        const refresh = async () => {
            const fresh = await fetchStaffContext(store.getState());

            if (cancelled) {
                return;
            }
            setContext(fresh);

            // A failed read keeps the last queue, so that an arrival during it still alerts on the next good read.
            if (!fresh) {
                return;
            }

            const queue = fresh.where === 'lounge' ? fresh.queue : undefined;

            if (isNewArrival(lastQueue.current, queue)) {
                dispatch(playSound(STAFF_QUEUE_SOUND_ID));
                notifyInBackground(t('staffActions.queueAlertTitle'),
                    t('staffActions.queueWaiting', { waiting: queue?.waiting ?? 0 }));
            }
            lastQueue.current = queue;
        };

        refresh();

        const timer = setInterval(refresh, REFRESH_MS);

        return () => {
            cancelled = true;
            clearInterval(timer);
        };
    }, [ outsidePatientsRoom, hasJwt, store, dispatch, t ]);

    const onNext = useCallback(async () => {
        const refused = await callNextPatient(store.getState());

        setMessage(refused === undefined ? undefined : refused === 'queue_empty' ? 'staffActions.queueEmpty'
            : 'staffActions.nextRefused');
    }, [ store ]);

    const onAllowNotifications = useCallback(async () => {
        try {
            await Notification.requestPermission();
        } finally {
            setAskNotifications(canAskForNotifications());
        }
    }, []);

    if (context?.where !== 'lounge') {
        return null;
    }

    const queue = context.queue;

    return (
        <div
            className = { classes.panel }
            id = 'staff-next-panel'>
            { queue && (
                <span
                    aria-live = 'polite'
                    className = { classes.queue }
                    id = 'staff-queue-count'>
                    { queue.waiting
                        ? `${t('staffActions.queueWaiting', { waiting: queue.waiting })} · ${
                            t('staffActions.queueLongest', { minutes: Math.ceil((queue.longestWaitSeconds ?? 0) / 60) })}`
                        : t('staffActions.queueNobody') }
                </span>
            ) }
            <Button
                accessibilityLabel = { t('staffActions.nextPatient') }
                id = 'staff-next-patient'
                labelKey = 'staffActions.nextPatient'
                onClick = { onNext } />
            { askNotifications && (
                <Button
                    accessibilityLabel = { t('staffActions.allowNotifications') }
                    id = 'staff-allow-notifications'
                    labelKey = 'staffActions.allowNotifications'
                    onClick = { onAllowNotifications }
                    type = 'secondary' />
            ) }
            { message && (
                <span
                    className = { classes.message }
                    id = 'staff-next-message'>
                    { t(message) }
                </span>
            ) }
        </div>
    );
};

export default NextPatientPanel;
