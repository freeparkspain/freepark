import {
  bearingBetween,
  normalizeBearing,
  resolveTravelBearing,
  shortestBearingDelta,
  stepBearing,
} from '../navigation/services/bearing';

describe('normalizeBearing', () => {
  it('wraps into [0,360)', () => {
    expect(normalizeBearing(370)).toBe(10);
    expect(normalizeBearing(-10)).toBe(350);
    expect(normalizeBearing(720)).toBe(0);
  });
});

describe('shortestBearingDelta', () => {
  it('takes the short path from 350 to 10 (+20, not -340)', () => {
    expect(shortestBearingDelta(350, 10)).toBe(20);
  });
  it('is negative going the other way', () => {
    expect(shortestBearingDelta(10, 350)).toBe(-20);
  });
});

describe('bearingBetween', () => {
  it('points north and east correctly', () => {
    expect(bearingBetween({ latitude: 0, longitude: 0 }, { latitude: 1, longitude: 0 })).toBeCloseTo(0, 1);
    expect(bearingBetween({ latitude: 0, longitude: 0 }, { latitude: 0, longitude: 1 })).toBeCloseTo(90, 1);
  });
});

describe('stepBearing', () => {
  it('snaps to target within the max step', () => {
    expect(stepBearing(10, 15, 10)).toBe(15);
  });
  it('moves at most maxStep along the short path', () => {
    expect(stepBearing(350, 40, 10)).toBe(0); // +10 from 350 → 0
  });
});

describe('resolveTravelBearing', () => {
  const base = {
    segmentBearing: 90,
    gpsBearing: 45 as number | null,
    prevMatched: null,
    currentMatched: { latitude: 0, longitude: 0 },
    lastStable: 200,
    minReliableSpeedMps: 1.5,
  };

  it('prefers the matched segment bearing when snapped', () => {
    expect(resolveTravelBearing({ ...base, snapped: true, speedMps: 10 })).toBe(90);
  });

  it('uses GPS heading when moving and not snapped', () => {
    expect(resolveTravelBearing({ ...base, snapped: false, speedMps: 10 })).toBe(45);
  });

  it('holds the last stable bearing while stationary (no spinning in place)', () => {
    expect(resolveTravelBearing({ ...base, snapped: false, speedMps: 0 })).toBe(200);
  });

  it('rejects an unrealistic ~180° flip at low speed', () => {
    // snapped segment reversed vs last stable, but essentially stopped.
    expect(resolveTravelBearing({ ...base, snapped: true, segmentBearing: 20, lastStable: 200, speedMps: 0 })).toBe(200);
  });
});
