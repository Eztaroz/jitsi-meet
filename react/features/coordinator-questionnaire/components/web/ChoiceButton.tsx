import React, { useCallback } from 'react';

import Button from '../../../base/ui/components/web/Button';
import { BUTTON_TYPES } from '../../../base/ui/constants.web';

interface IProps {
    choice: string;
    className: string;
    index: number;
    onChoose: (question: number, choice: number) => void;
    question: number;
    selected: boolean;
}

/**
 * One of the two choices of a question.
 *
 * @param {IProps} props - The choice, and what to do when it is picked.
 * @returns {ReactElement}
 */
export default function ChoiceButton({ choice, className, index, onChoose, question, selected }: IProps) {
    const onClick = useCallback(() => onChoose(question, index), [ index, onChoose, question ]);

    return (
        <Button
            accessibilityLabel = { choice }
            className = { className }
            id = { `coordinator-questionnaire-${question}-${index}` }
            label = { choice }
            onClick = { onClick }
            type = { selected ? BUTTON_TYPES.PRIMARY : BUTTON_TYPES.SECONDARY } />
    );
}
