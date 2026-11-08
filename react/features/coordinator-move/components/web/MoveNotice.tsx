import React, { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useDispatch, useSelector } from 'react-redux';
import { keyframes } from 'tss-react';
import { makeStyles } from 'tss-react/mui';

import { IReduxState } from '../../../app/types';
import Button from '../../../base/ui/components/web/Button';
import { BUTTON_TYPES } from '../../../base/ui/constants.web';
import { cancelMove } from '../../actions';

/** How often the countdown is redrawn, in milliseconds. */
const TICK_MS = 250;

/** The countdown ring's size and stroke, in pixels. */
const RING_SIZE = 132;
const RING_STROKE = 8;
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2;
const RING_LENGTH = 2 * Math.PI * RING_RADIUS;

const fadeIn = keyframes`
    from { opacity: 0; }
    to { opacity: 1; }
`;

const popIn = keyframes`
    from { opacity: 0; transform: scale(0.94) translateY(8px); }
    to { opacity: 1; transform: none; }
`;

const useStyles = makeStyles()(theme => {
    return {
        backdrop: {
            alignItems: 'center',
            animation: `${fadeIn} 200ms ease-out`,
            backdropFilter: 'blur(3px)',
            backgroundColor: 'rgba(0, 0, 0, 0.55)',
            display: 'flex',
            inset: 0,
            justifyContent: 'center',
            padding: theme.spacing(3),
            position: 'fixed',
            zIndex: 400,

            '@media (prefers-reduced-motion: reduce)': {
                animation: 'none'
            }
        },
        dialog: {
            alignItems: 'center',
            animation: `${popIn} 260ms cubic-bezier(0.2, 0.8, 0.2, 1)`,
            backgroundColor: theme.palette.ui01,
            border: `1px solid ${theme.palette.ui03}`,
            borderRadius: '20px',
            boxShadow: '0 24px 64px rgba(0, 0, 0, 0.5)',
            boxSizing: 'border-box',
            color: theme.palette.text01,
            display: 'flex',
            flexDirection: 'column',
            gap: theme.spacing(3),
            maxWidth: '380px',
            padding: `${theme.spacing(5)} ${theme.spacing(4)} ${theme.spacing(4)}`,
            textAlign: 'center',
            width: '100%',

            '@media (prefers-reduced-motion: reduce)': {
                animation: 'none'
            }
        },
        ring: {
            height: RING_SIZE,
            position: 'relative',
            width: RING_SIZE
        },
        ringSvg: {
            display: 'block',
            transform: 'rotate(-90deg)'
        },
        ringTrack: {
            stroke: theme.palette.ui03
        },
        ringFill: {
            stroke: theme.palette.action01,
            transition: `stroke-dashoffset ${TICK_MS}ms linear`,

            '@media (prefers-reduced-motion: reduce)': {
                transition: 'none'
            }
        },
        count: {
            alignItems: 'center',
            display: 'flex',
            flexDirection: 'column',
            inset: 0,
            justifyContent: 'center',
            position: 'absolute'
        },
        seconds: {
            fontSize: '44px',
            fontVariantNumeric: 'tabular-nums',
            fontWeight: 700,
            lineHeight: '48px'
        },
        unit: {
            color: theme.palette.text02,
            fontSize: '13px',
            lineHeight: '16px'
        },
        title: {
            fontSize: '20px',
            fontWeight: 600,
            lineHeight: '28px',
            margin: 0
        },
        hint: {
            color: theme.palette.text02,
            fontSize: '14px',
            lineHeight: '20px',
            margin: 0
        }
    };
});

/**
 * Tells a participant they are being moved to another room, and counts down on a ring in a dialog over the call. It
 * never says which room. The participant can stay.
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

        const timer = setInterval(() => setTick(tick => tick + 1), TICK_MS);

        return () => clearInterval(timer);
    }, [ move ]);

    if (!move) {
        return null;
    }

    const remaining = Math.max(0, move.endsAt - Date.now());
    const seconds = Math.ceil(remaining / 1000);
    const left = move.countdownSeconds > 0 ? Math.min(1, remaining / (move.countdownSeconds * 1000)) : 0;

    return (
        <div className = { classes.backdrop }>
            <div
                aria-describedby = 'coordinator-move-hint'
                aria-labelledby = 'coordinator-move-title'
                className = { classes.dialog }
                id = 'coordinator-move-notice'
                role = 'alertdialog'>
                { /* Read out once through the title; a number that changes four times a second is only seen. */ }
                <div
                    aria-hidden = 'true'
                    className = { classes.ring }>
                    <svg
                        className = { classes.ringSvg }
                        height = { RING_SIZE }
                        width = { RING_SIZE }>
                        <circle
                            className = { classes.ringTrack }
                            cx = { RING_SIZE / 2 }
                            cy = { RING_SIZE / 2 }
                            fill = 'none'
                            r = { RING_RADIUS }
                            strokeWidth = { RING_STROKE } />
                        <circle
                            className = { classes.ringFill }
                            cx = { RING_SIZE / 2 }
                            cy = { RING_SIZE / 2 }
                            fill = 'none'
                            r = { RING_RADIUS }
                            strokeDasharray = { RING_LENGTH }
                            strokeDashoffset = { RING_LENGTH * (1 - left) }
                            strokeLinecap = 'round'
                            strokeWidth = { RING_STROKE } />
                    </svg>
                    <div className = { classes.count }>
                        <span className = { classes.seconds }>{ seconds }</span>
                        <span className = { classes.unit }>{ t('coordinatorMove.seconds') }</span>
                    </div>
                </div>
                <p
                    className = { classes.title }
                    id = 'coordinator-move-title'>
                    { t('coordinatorMove.title') }
                </p>
                <p
                    className = { classes.hint }
                    id = 'coordinator-move-hint'>
                    { t('coordinatorMove.hint') }
                </p>
                <Button
                    accessibilityLabel = { t('coordinatorMove.cancel') }
                    fullWidth = { true }
                    id = 'coordinator-move-cancel'
                    labelKey = 'coordinatorMove.cancel'
                    onClick = { onCancel }
                    size = 'large'
                    type = { BUTTON_TYPES.SECONDARY } />
            </div>
        </div>
    );
};

export default MoveNotice;
