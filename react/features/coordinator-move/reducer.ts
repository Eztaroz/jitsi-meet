import ReducerRegistry from '../base/redux/ReducerRegistry';

import { START_MOVE } from './actionTypes';
import { IMove } from './functions';

export interface ICoordinatorMoveState {

    /** The move under way, and when its countdown ends (ms since epoch). */
    move?: IMove & { endsAt: number; };
}

ReducerRegistry.register<ICoordinatorMoveState>('features/coordinator-move', (state = {}, action): ICoordinatorMoveState => {
    switch (action.type) {
    case START_MOVE:
        return { move: { ...action.move, endsAt: action.endsAt } };
    }

    return state;
});
