import { OsmParking } from '../types/parking';
import {
  MAX_PERSISTED_PARKINGS,
  PARKING_CACHE_TTL_MS,
  compactCoverage,
  coveredFraction,
  decodeParkingCache,
  encodeParkingCache,
  isContainedInAny,
  mergeParking,
  validateParkingArray,
} from '../services/cache/parkingCacheModel';

const NOW = 2_000_000_000_000;

function parking(id: string, latitude = 36.72, longitude = -4.42): OsmParking {
  return {
    id,
    position: { latitude, longitude },
    polygon: null,
    polyline: null,
    tags: { amenity: 'parking', fee: 'no' },
  };
}

describe('parking cache validation', () => {
  it('drops malformed parking elements instead of trusting a type assertion', () => {
    const result = validateParkingArray([
      parking('w1'),
      { id: 'broken' },
      parking('nan', Number.NaN),
      { ...parking('bad-tags'), tags: { fee: 123 } },
    ]);
    expect(result.validContainer).toBe(true);
    expect(result.items.map((item) => item.id)).toEqual(['w1']);
    expect(result.dropped).toBe(3);
  });

  it('rejects a non-array provider payload', () => {
    expect(validateParkingArray({ elements: [] }).validContainer).toBe(false);
  });

  it('invalidates a timestamp-less legacy array without fabricating coverage', () => {
    const decoded = decodeParkingCache(JSON.stringify([parking('w1')]), NOW);
    expect(decoded.corrupt).toBe(false);
    expect(decoded.needsRewrite).toBe(true);
    expect(decoded.snapshot).toEqual({ entries: [], coverage: [] });
  });

  it('drops syntactically valid but schema-invalid persisted data', () => {
    const decoded = decodeParkingCache(JSON.stringify({ version: 2, savedAt: NOW, entries: [{ parking: { id: 'x' }, updatedAt: NOW }], coverage: [] }), NOW);
    expect(decoded.snapshot.entries).toEqual([]);
    expect(decoded.needsRewrite).toBe(true);
  });

  it('expires parking entries and exact coverage by TTL', () => {
    const stale = NOW - PARKING_CACHE_TTL_MS - 1;
    const raw = JSON.stringify({
      version: 2,
      savedAt: stale,
      entries: [{ parking: parking('w1'), updatedAt: stale }],
      coverage: [{ bounds: { south: 0, west: 0, north: 1, east: 1 }, fetchedAt: stale }],
    });
    const decoded = decodeParkingCache(raw, NOW);
    expect(decoded.snapshot).toEqual({ entries: [], coverage: [] });
    expect(decoded.needsRewrite).toBe(true);
  });
});

describe('parking cache updates and bounds', () => {
  it('upserts fresh values while preserving already fetched geometry', () => {
    const polygon = [
      { latitude: 1, longitude: 1 },
      { latitude: 1, longitude: 2 },
      { latitude: 2, longitude: 1 },
    ];
    const old = { ...parking('w1'), polygon, tags: { fee: 'yes' } };
    const merged = mergeParking(old, { ...parking('w1'), tags: { fee: 'no' } });
    expect(merged.tags.fee).toBe('no');
    expect(merged.polygon).toBe(polygon);
  });

  it('bounds persistence and drops coverage if base markers were evicted', () => {
    const entries = Array.from({ length: MAX_PERSISTED_PARKINGS + 1 }, (_, index) => ({
      parking: parking(`w${index}`),
      updatedAt: NOW - index,
    }));
    const encoded = encodeParkingCache({
      entries,
      coverage: [{ bounds: { south: 0, west: 0, north: 1, east: 1 }, fetchedAt: NOW }],
    }, NOW);
    const parsed = JSON.parse(encoded);
    expect(parsed.entries).toHaveLength(MAX_PERSISTED_PARKINGS);
    expect(parsed.coverage).toEqual([]);
  });
});

describe('exact fetched coverage', () => {
  const target = { south: 0, west: 0, north: 10, east: 10 };

  it('does not double-count overlapping rectangles', () => {
    const sameHalf = { bounds: { south: 0, west: 0, north: 10, east: 5 }, fetchedAt: NOW };
    expect(coveredFraction(target, [sameHalf, sameHalf])).toBe(0.5);
  });

  it('keeps sparse rectangles separate and does not invent their bounding box', () => {
    const coverage = compactCoverage([
      { bounds: { south: 0, west: 0, north: 2, east: 2 }, fetchedAt: NOW },
      { bounds: { south: 8, west: 8, north: 10, east: 10 }, fetchedAt: NOW },
    ]);
    expect(isContainedInAny({ south: 4, west: 4, north: 6, east: 6 }, coverage)).toBe(false);
    expect(coveredFraction(target, coverage)).toBeCloseTo(0.08);
  });
});
