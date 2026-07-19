import {
  destinationSelectionReducer,
  EMPTY_DESTINATION_SELECTION,
} from '../hooks/useDestinationSelection';
import { OsmParking, SelectedDestination } from '../types/parking';

const parking: OsmParking = {
  id: 'w1',
  position: { latitude: 1, longitude: 2 },
  polygon: null,
  polyline: null,
  tags: { fee: 'no' },
};

const destination = (type: SelectedDestination['type']): SelectedDestination => ({
  id: `${type}-1`,
  type,
  title: type,
  position: { latitude: 1, longitude: 2 },
});

describe('destinationSelectionReducer', () => {
  it('keeps exactly one destination representation active', () => {
    const search = destinationSelectionReducer(EMPTY_DESTINATION_SELECTION, {
      type: 'search',
      pin: { latitude: 1, longitude: 2, address: 'Search' },
      destination: destination('search'),
    });
    const selectedParking = destinationSelectionReducer(search, {
      type: 'parking', parking, destination: destination('parking'),
    });
    expect(selectedParking.searchPin).toBeNull();
    expect(selectedParking.droppedPin).toBeNull();
    expect(selectedParking.selectedParking).toBe(parking);
  });

  it('updates only the currently selected dropped pin', () => {
    const pin = destinationSelectionReducer(EMPTY_DESTINATION_SELECTION, {
      type: 'pin',
      pin: { id: 7, latitude: 1, longitude: 2, address: 'Searching…', loading: true },
      destination: { ...destination('pin'), id: 'pin-7' },
    });
    const stale = destinationSelectionReducer(pin, {
      type: 'pinAddress', pinId: 6, destinationId: 'pin-6', address: 'Wrong',
    });
    expect(stale).toBe(pin);
    const updated = destinationSelectionReducer(pin, {
      type: 'pinAddress', pinId: 7, destinationId: 'pin-7', address: 'Main Street',
    });
    expect(updated.droppedPin?.address).toBe('Main Street');
    expect(updated.selectedDestination?.title).toBe('Main Street');
  });

  it('clears destination and every visual selection atomically', () => {
    const selected = destinationSelectionReducer(EMPTY_DESTINATION_SELECTION, {
      type: 'parking', parking, destination: destination('parking'),
    });
    expect(destinationSelectionReducer(selected, { type: 'clear' })).toBe(
      EMPTY_DESTINATION_SELECTION,
    );
  });
});
