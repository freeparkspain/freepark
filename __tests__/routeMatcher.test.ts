import {
  buildRouteIndex,
  firstSegmentBearing,
  matchToRoute,
} from '../navigation/services/routeMatcher';
import { CarTrackingConfig } from '../types/navigation';
import { LatLng } from '../types/parking';

const config: CarTrackingConfig = {
  maximumSnapDistanceMeters: 35,
  maximumBackwardProgressMeters: 20,
  searchSegmentsBehind: 15,
  searchSegmentsAhead: 100,
  minReliableSpeedMps: 1.5,
};

// Straight west→east route at latitude 40.
const coords: LatLng[] = [
  { latitude: 40, longitude: 0.000 },
  { latitude: 40, longitude: 0.003 },
  { latitude: 40, longitude: 0.006 },
  { latitude: 40, longitude: 0.009 },
];
const index = buildRouteIndex(coords);
const total = index.cumulative[index.cumulative.length - 1];

describe('buildRouteIndex', () => {
  it('produces monotonically increasing cumulative distances', () => {
    for (let i = 1; i < index.cumulative.length; i++) {
      expect(index.cumulative[i]).toBeGreaterThan(index.cumulative[i - 1]);
    }
  });
});

describe('matchToRoute', () => {
  it('snaps a point that is close to the route', () => {
    // ~10 m north of the segment mid-point.
    const raw = { latitude: 40 + 10 / 111_320, longitude: 0.0015 };
    const m = matchToRoute(index, raw, null, config);
    expect(m.isSnappedToRoute).toBe(true);
    expect(m.distanceFromRouteMeters).toBeLessThan(config.maximumSnapDistanceMeters);
    expect(m.matchedPosition.latitude).toBeCloseTo(40, 4); // snapped back onto the line
  });

  it('does NOT snap a point that is far from the route', () => {
    const raw = { latitude: 40 + 100 / 111_320, longitude: 0.0015 }; // ~100 m off
    const m = matchToRoute(index, raw, null, config);
    expect(m.isSnappedToRoute).toBe(false);
    expect(m.matchedPosition).toEqual(raw); // keeps the raw position
  });

  it('advances progress moving forward along the route', () => {
    const a = matchToRoute(index, { latitude: 40, longitude: 0.001 }, null, config);
    const b = matchToRoute(index, { latitude: 40, longitude: 0.005 },
      { progressMeters: a.routeProgressMeters, segmentIndex: a.routeSegmentIndex }, config);
    expect(b.routeProgressMeters).toBeGreaterThan(a.routeProgressMeters);
  });

  it('prevents a large backward jump (holds previous progress)', () => {
    const prev = { progressMeters: total * 0.9, segmentIndex: coords.length - 2 };
    // Raw near the start would project to a tiny progress — must be rejected.
    const m = matchToRoute(index, { latitude: 40, longitude: 0.0005 }, prev, config);
    expect(m.routeProgressMeters).toBeCloseTo(prev.progressMeters, 0);
  });

  it('ignores a stale segment from a longer previous route', () => {
    const stalePreviousRouteMatch = {
      progressMeters: 50_000,
      segmentIndex: 250,
    };

    expect(() => matchToRoute(
      index,
      { latitude: 40, longitude: 0.004 },
      stalePreviousRouteMatch,
      config,
    )).not.toThrow();

    const match = matchToRoute(
      index,
      { latitude: 40, longitude: 0.004 },
      stalePreviousRouteMatch,
      config,
    );
    expect(match.routeSegmentIndex).toBeGreaterThanOrEqual(0);
    expect(match.routeSegmentIndex).toBeLessThan(coords.length - 1);
    expect(Number.isFinite(match.bearing)).toBe(true);
  });
});

describe('firstSegmentBearing', () => {
  it('returns the bearing of the first segment (~east = 90)', () => {
    expect(firstSegmentBearing(coords)).toBeCloseTo(90, 0);
  });
  it('returns null for a degenerate route', () => {
    expect(firstSegmentBearing([{ latitude: 0, longitude: 0 }])).toBeNull();
  });
});
