import { LatestSearchRequest, parsePhotonResponse } from '../utils/photon';

describe('LatestSearchRequest', () => {
  it('aborts an older request and accepts only the latest ID', () => {
    const tracker = new LatestSearchRequest();
    const first = tracker.start();
    const second = tracker.start();

    expect(first.controller.signal.aborted).toBe(true);
    expect(tracker.isCurrent(first.requestId)).toBe(false);
    expect(tracker.isCurrent(second.requestId)).toBe(true);
  });

  it('invalidates the active request during clear or unmount', () => {
    const tracker = new LatestSearchRequest();
    const active = tracker.start();
    tracker.invalidate();

    expect(active.controller.signal.aborted).toBe(true);
    expect(tracker.isCurrent(active.requestId)).toBe(false);
  });
});

describe('parsePhotonResponse', () => {
  it('maps valid GeoJSON coordinates and builds a useful label', () => {
    expect(parsePhotonResponse({
      features: [{
        geometry: { coordinates: [-4.42, 36.72] },
        properties: {
          osm_id: 123,
          osm_type: 'W',
          street: 'Calle Larios',
          housenumber: '1',
          city: 'Malaga',
        },
      }],
    })).toEqual([{
      key: 'W:123:-4.42:36.72',
      displayName: 'Calle Larios 1, Malaga',
      latitude: 36.72,
      longitude: -4.42,
    }]);
  });

  it('returns an empty list for malformed envelopes', () => {
    expect(parsePhotonResponse(null)).toEqual([]);
    expect(parsePhotonResponse({})).toEqual([]);
    expect(parsePhotonResponse({ features: 'bad' })).toEqual([]);
  });

  it('drops malformed, non-finite and out-of-range features independently', () => {
    const response = parsePhotonResponse({
      features: [
        null,
        { geometry: { coordinates: [Infinity, 36] }, properties: { osm_id: 1, name: 'Bad' } },
        { geometry: { coordinates: [0, 91] }, properties: { osm_id: 2, name: 'Bad' } },
        { geometry: { coordinates: [0, 40] }, properties: { osm_id: 3 } },
        { geometry: { coordinates: [2, 41] }, properties: { osm_id: '4', name: 'Good' } },
      ],
    });
    expect(response).toHaveLength(1);
    expect(response[0].displayName).toBe('Good');
  });
});
