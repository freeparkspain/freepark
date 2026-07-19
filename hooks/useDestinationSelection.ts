import { useCallback, useReducer } from 'react';
import { OsmParking, SelectedDestination } from '../types/parking';

export interface SearchPin {
  latitude: number;
  longitude: number;
  address: string;
}

export interface DroppedPin extends SearchPin {
  id: number;
  loading: boolean;
}

export interface DestinationSelectionState {
  selectedParking: OsmParking | null;
  selectedDestination: SelectedDestination | null;
  searchPin: SearchPin | null;
  droppedPin: DroppedPin | null;
}

export const EMPTY_DESTINATION_SELECTION: DestinationSelectionState = {
  selectedParking: null,
  selectedDestination: null,
  searchPin: null,
  droppedPin: null,
};

export type DestinationSelectionAction =
  | { type: 'clear' }
  | { type: 'parking'; parking: OsmParking; destination: SelectedDestination }
  | { type: 'search'; pin: SearchPin; destination: SelectedDestination }
  | { type: 'pin'; pin: DroppedPin; destination: SelectedDestination }
  | { type: 'pinAddress'; pinId: number; destinationId: string; address: string };

export function destinationSelectionReducer(
  state: DestinationSelectionState,
  action: DestinationSelectionAction,
): DestinationSelectionState {
  switch (action.type) {
    case 'clear':
      return EMPTY_DESTINATION_SELECTION;
    case 'parking':
      return {
        selectedParking: action.parking,
        selectedDestination: action.destination,
        searchPin: null,
        droppedPin: null,
      };
    case 'search':
      return {
        selectedParking: null,
        selectedDestination: action.destination,
        searchPin: action.pin,
        droppedPin: null,
      };
    case 'pin':
      return {
        selectedParking: null,
        selectedDestination: action.destination,
        searchPin: null,
        droppedPin: action.pin,
      };
    case 'pinAddress':
      if (state.droppedPin?.id !== action.pinId) return state;
      return {
        ...state,
        droppedPin: { ...state.droppedPin, address: action.address, loading: false },
        selectedDestination: state.selectedDestination?.id === action.destinationId
          ? { ...state.selectedDestination, title: action.address }
          : state.selectedDestination,
      };
  }
}

export function useDestinationSelection() {
  const [state, dispatch] = useReducer(
    destinationSelectionReducer,
    EMPTY_DESTINATION_SELECTION,
  );

  const clear = useCallback(() => dispatch({ type: 'clear' }), []);
  const selectParking = useCallback(
    (parking: OsmParking, destination: SelectedDestination) =>
      dispatch({ type: 'parking', parking, destination }),
    [],
  );
  const selectSearch = useCallback(
    (pin: SearchPin, destination: SelectedDestination) =>
      dispatch({ type: 'search', pin, destination }),
    [],
  );
  const selectPin = useCallback(
    (pin: DroppedPin, destination: SelectedDestination) =>
      dispatch({ type: 'pin', pin, destination }),
    [],
  );
  const updatePinAddress = useCallback(
    (pinId: number, destinationId: string, address: string) =>
      dispatch({ type: 'pinAddress', pinId, destinationId, address }),
    [],
  );

  return { ...state, clear, selectParking, selectSearch, selectPin, updatePinAddress };
}
