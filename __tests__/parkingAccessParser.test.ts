import {
  buildParkingAccessQuery,
  calculateParkingAccessRadius,
  parseParkingAccessContext,
} from '../services/overpassService';
import { OsmParking } from '../types/parking';

function parking(overrides: Partial<OsmParking> = {}): OsmParking {
  return {
    id: 'w42',
    position: { latitude: 36.72, longitude: -4.42 },
    polygon: null,
    polyline: null,
    tags: {},
    ...overrides,
  };
}

describe('selected parking access context', () => {
  it('uses a bounded radius based on the selected zone extent', () => {
    expect(calculateParkingAccessRadius(parking())).toBe(50);

    const medium = parking({
      polyline: [
        { latitude: 36.72, longitude: -4.42 },
        { latitude: 36.721, longitude: -4.42 },
      ],
    });
    expect(calculateParkingAccessRadius(medium)).toBeGreaterThanOrEqual(150);
    expect(calculateParkingAccessRadius(medium)).toBeLessThan(160);

    const veryLarge = parking({
      polygon: [
        { latitude: 36.72, longitude: -4.42 },
        { latitude: 36.73, longitude: -4.42 },
        { latitude: 36.72, longitude: -4.42 },
      ],
    });
    expect(calculateParkingAccessRadius(veryLarge)).toBe(250);
  });

  it('builds a selection-only bounded query for entrances and service roads', () => {
    const selected = parking();
    const query = buildParkingAccessQuery(selected);

    expect(query).toContain('[timeout:10][maxsize:500000]');
    expect(query).toContain('node["amenity"="parking_entrance"]');
    expect(query).toContain('(around:50,36.72,-4.42)');
    expect(query).toContain('way["highway"="service"]');
    expect(query).toContain('["access"!~"^(no|private)$"]');
    expect(query).toContain('["vehicle"!~"^(no|private)$"]');
    expect(query).toContain('out geom qt;');
  });

  it('returns an empty context for malformed envelopes without throwing', () => {
    for (const payload of [null, undefined, {}, { elements: null }, { elements: [null, 1] }]) {
      expect(() => parseParkingAccessContext(payload)).not.toThrow();
      expect(parseParkingAccessContext(payload)).toEqual({ entrances: [], serviceWays: [] });
    }
  });

  it('validates and deduplicates entrances', () => {
    const result = parseParkingAccessContext({
      elements: [
        { type: 'node', lat: 36.72, lon: -4.42, tags: { amenity: 'parking_entrance' } },
        { type: 'node', lat: 36.72000001, lon: -4.42000001, tags: { amenity: 'parking_entrance' } },
        { type: 'node', lat: NaN, lon: -4.42, tags: { amenity: 'parking_entrance' } },
        { type: 'node', lat: 95, lon: -4.42, tags: { amenity: 'parking_entrance' } },
        { type: 'node', lat: 36.721, lon: -4.421, tags: { amenity: 'parking_entrance', access: 'private' } },
        { type: 'node', lat: 36.722, lon: -4.422, tags: { amenity: 'parking_entrance', vehicle: 'no' } },
        { type: 'node', lat: 36.72, lon: -4.42, tags: { amenity: 'parking' } },
      ],
    });

    expect(result.entrances).toEqual([{ latitude: 36.72, longitude: -4.42 }]);
  });

  it('keeps drivable service geometry and rejects inaccessible or unrelated ways', () => {
    const driveway = [
      { lat: 36.72, lon: -4.42 },
      { lat: 36.7201, lon: -4.4201 },
    ];
    const result = parseParkingAccessContext({
      elements: [
        { type: 'way', tags: { highway: 'service', service: 'driveway' }, geometry: driveway },
        { type: 'way', tags: { highway: 'service', service: 'driveway' }, geometry: [...driveway].reverse() },
        {
          type: 'way',
          tags: { highway: 'service', service: 'parking_aisle' },
          geometry: [
            { lat: 36.721, lon: -4.421 },
            { lat: Infinity, lon: -4.4211 },
            { lat: 36.7212, lon: -4.4212 },
          ],
        },
        { type: 'way', tags: { highway: 'service', access: 'private' }, geometry: driveway },
        { type: 'way', tags: { highway: 'service', motor_vehicle: 'no' }, geometry: driveway },
        { type: 'way', tags: { highway: 'residential' }, geometry: driveway },
      ],
    });

    expect(result.serviceWays).toEqual([
      [
        { latitude: 36.72, longitude: -4.42 },
        { latitude: 36.7201, longitude: -4.4201 },
      ],
      [
        { latitude: 36.721, longitude: -4.421 },
        { latitude: 36.7212, longitude: -4.4212 },
      ],
    ]);
  });

  it('rejects an invalid selected parking position before issuing a request', () => {
    expect(() => buildParkingAccessQuery(parking({
      position: { latitude: NaN, longitude: -4.42 },
    }))).toThrow('invalid parking position');
  });
});
