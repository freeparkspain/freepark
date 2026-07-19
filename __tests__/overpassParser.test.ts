import {
  buildOverpassQuery,
  isOverpassEnvelope,
  parseOverpassData,
} from '../services/overpassService';

describe('parseOverpassData runtime validation', () => {
  it('distinguishes a real empty response from a malformed HTTP-200 envelope', () => {
    expect(isOverpassEnvelope({ elements: [] })).toBe(true);
    expect(isOverpassEnvelope({ remark: 'runtime error' })).toBe(false);
    expect(isOverpassEnvelope({ elements: null })).toBe(false);
  });

  it('never throws on malformed response envelopes or elements', () => {
    for (const value of [null, undefined, {}, { elements: null }, { elements: [null, 1, 'x', {}] }]) {
      expect(() => parseOverpassData(value)).not.toThrow();
      expect(parseOverpassData(value)).toEqual([]);
    }
  });

  it('accepts valid nodes and strips non-string tags', () => {
    const parsed = parseOverpassData({
      elements: [{
        type: 'node',
        id: 10,
        lat: 36.7,
        lon: -4.4,
        tags: { amenity: 'parking', fee: 'no', capacity: 12 },
      }],
    });
    expect(parsed).toEqual([{
      id: 'n10',
      position: { latitude: 36.7, longitude: -4.4 },
      polygon: null,
      polyline: null,
      tags: { amenity: 'parking', fee: 'no' },
    }]);
  });

  it('drops invalid coordinates, IDs and restricted parking', () => {
    const parsed = parseOverpassData({
      elements: [
        { type: 'node', id: 1, lat: NaN, lon: 0, tags: {} },
        { type: 'node', id: 2, lat: 91, lon: 0, tags: {} },
        { type: 'node', id: 'not-an-id', lat: 1, lon: 1, tags: {} },
        { type: 'node', id: 3, lat: 1, lon: 1, tags: { access: 'private' } },
        { type: 'node', id: 4, lat: 1, lon: 1, tags: { access: 'customers' } },
        { type: 'node', id: 5, lat: 1, lon: 1, tags: { access: 'permit' } },
      ],
    });
    expect(parsed).toEqual([]);
  });

  it('uses a valid center or validated geometry and skips origin fallbacks', () => {
    const parsed = parseOverpassData({
      elements: [
        { type: 'way', id: 20, tags: {}, center: { lat: 10, lon: 20 } },
        { type: 'way', id: 21, tags: {}, geometry: [{ lat: 1, lon: 1 }, { lat: 2, lon: 2 }] },
        { type: 'relation', id: 22, tags: {}, members: [] },
      ],
    });
    expect(parsed.map(item => item.id)).toEqual(['w20', 'w21']);
    expect(parsed[1].position).toEqual({ latitude: 1.5, longitude: 1.5 });
    expect(parsed[1].polyline).toHaveLength(2);
  });

  it('loads the current OSM street-parking scheme and normalises side tags', () => {
    const query = buildOverpassQuery(36.7, -4.5, 36.8, -4.4);
    expect(query).toContain('["parking:left"~');
    expect(query).toContain('["parking:right"~');
    expect(query).toContain('["parking:both"~');

    const [parking] = parseOverpassData({
      elements: [{
        type: 'way',
        id: 99,
        center: { lat: 36.72, lon: -4.42 },
        tags: {
          highway: 'residential',
          'parking:right': 'lane',
          'parking:right:fee': 'yes',
        },
      }],
    });
    expect(parking.tags.__parking_geometry).toBe('street');
    expect(parking.tags.__parking_sides).toBe('right');
    expect(parking.tags.fee).toBe('yes');
  });

  it('stitches split relation members into one closed outer ring', () => {
    const [parking] = parseOverpassData({
      elements: [{
        type: 'relation',
        id: 101,
        center: { lat: 0.5, lon: 0.5 },
        tags: { amenity: 'parking' },
        members: [
          {
            type: 'way',
            role: 'outer',
            geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }],
          },
          {
            type: 'way',
            role: 'outer',
            geometry: [{ lat: 0, lon: 0 }, { lat: 1, lon: 0 }, { lat: 1, lon: 1 }],
          },
        ],
      }],
    });

    expect(parking.polygon).toHaveLength(5);
    expect(parking.polygon?.[0]).toEqual(parking.polygon?.[4]);
  });

  it('does not auto-close an incomplete relation across the map', () => {
    const [parking] = parseOverpassData({
      elements: [{
        type: 'relation',
        id: 102,
        center: { lat: 1, lon: 1 },
        tags: { amenity: 'parking' },
        members: [{
          type: 'way',
          role: 'outer',
          geometry: [{ lat: 0, lon: 0 }, { lat: 0, lon: 1 }, { lat: 1, lon: 1 }],
        }],
      }],
    });

    expect(parking.polygon).toBeNull();
  });
});
