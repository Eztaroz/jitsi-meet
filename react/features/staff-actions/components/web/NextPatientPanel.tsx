import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useSelector, useStore } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import { isPatientsRoom } from '../../../base/participants/functions';
import Button from '../../../base/ui/components/web/Button';
import { callNextPatient, fetchStaffContext } from '../../functions.web';
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
        message: {
            flexBasis: '100%'
        }
    };
});

/**
 * Shows a staff member, in a station's lounge, a "next patient" button (ADR 0012). Pressing it makes the service move
 * them to the longest-waiting patient of their station, or tells them that the queue is empty. It shows nothing to
 * anyone the service does not take for staff in a lounge.
 *
 * @returns {ReactElement|null}
 */
const NextPatientPanel = () => {
    const store = useStore<IReduxState>();
    const outsidePatientsRoom = useSelector((state: IReduxState) => !isPatientsRoom(state));
    const hasJwt = useSelector((state: IReduxState) => Boolean(state['features/base/jwt'].jwt));
    const [ context, setContext ] = useState<IStaffContext | undefined>();
    const [ message, setMessage ] = useState<string | undefined>();
    const { t } = useTranslation();
    const { classes } = useStyles();

    useEffect(() => {
        if (!outsidePatientsRoom || !hasJwt) {
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
    }, [ outsidePatientsRoom, hasJwt, store ]);

    const onNext = useCallback(async () => {
        const refused = await callNextPatient(store.getState());

        setMessage(refused === undefined ? undefined : refused === 'queue_empty' ? 'staffActions.queueEmpty'
            : 'staffActions.nextRefused');
    }, [ store ]);

    if (context?.where !== 'lounge') {
        return null;
    }

    return (
        <div
            className = { classes.panel }
            id = 'staff-next-panel'>
            <Button
                accessibilityLabel = { t('staffActions.nextPatient') }
                id = 'staff-next-patient'
                labelKey = 'staffActions.nextPatient'
                onClick = { onNext } />
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
