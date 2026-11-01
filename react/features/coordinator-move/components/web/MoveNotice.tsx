import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import Button from '../../../base/ui/components/web/Button';
import { BUTTON_TYPES } from '../../../base/ui/constants.web';
import { cancelMove } from '../../actions';

const useStyles = makeStyles()(theme => {
    return {
        notice: {
            backgroundColor: theme.palette.ui01,
            border: `1px solid ${theme.palette.ui03}`,
            borderRadius: '8px',
            boxShadow: '0 4px 16px rgba(0, 0, 0, 0.4)',
            color: theme.palette.text01,
            left: '50%',
            padding: theme.spacing(3),
            position: 'fixed',
            textAlign: 'center',
            top: theme.spacing(8),
            transform: 'translateX(-50%)',
            zIndex: 400
        }
    };
});

/**
 * Tells a participant they are being moved to another room, and counts down. It never says which room.
 *
 * @returns {ReactElement|null}
 */
const MoveNotice = () => {
    const move = useSelector((state: IReduxState) => state['features/coordinator-move'].move);
    const dispatch = useDispatch();
    const { t } = useTranslation();
    const { classes } = useStyles();

    // Only re-renders the notice every tick; the time left is read at render, so the first frame is right too.
    const [ , setTick ] = useState(0);
    const onCancel = useCallback(() => dispatch(cancelMove()), [ dispatch ]);

    useEffect(() => {
        if (!move) {
            return;
        }

        const timer = setInterval(() => setTick(tick => tick + 1), 250);

        return () => clearInterval(timer);
    }, [ move ]);

    if (!move) {
        return null;
    }

    const seconds = Math.max(0, Math.ceil((move.endsAt - Date.now()) / 1000));

    return (
        <div
            aria-live = 'assertive'
            className = { classes.notice }
            id = 'coordinator-move-notice'
            role = 'alert'>
            <p>{ t('coordinatorMove.notice', { seconds }) }</p>
            <Button
                accessibilityLabel = { t('coordinatorMove.cancel') }
                id = 'coordinator-move-cancel'
                labelKey = 'coordinatorMove.cancel'
                onClick = { onCancel }
                type = { BUTTON_TYPES.SECONDARY } />
        </div>
    );
};

export default MoveNotice;
