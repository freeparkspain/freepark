import {
  getParkingLod,
  zoomFromDelta,
  LOD_MEDIUM_MIN_ZOOM,
  LOD_HIGH_MIN_ZOOM,
} from '../constants/parkingLod';

// Exact latitudeDelta that maps to a given Web-Mercator zoom (inverse of
// zoomFromDelta) — lets the tests target specific zoom levels precisely.
const deltaForZoom = (z: number) => 360 / 2 ** z;

describe('parking Level of Detail thresholds', () => {
  it('is "low" at city zoom (~12) — markers only, no geometry', () => {
    expect(getParkingLod(deltaForZoom(12), 'low')).toBe('low');
  });

  it('is "medium" at neighbourhood zoom (~15) — simplified outlines', () => {
    expect(getParkingLod(deltaForZoom(15), 'low')).toBe('medium');
  });

  it('is "high" at street zoom (~17) — full geometry', () => {
    expect(getParkingLod(deltaForZoom(17), 'low')).toBe('high');
  });

  it('crosses low → medium exactly at LOD_MEDIUM_MIN_ZOOM', () => {
    // Just below the threshold stays low; a bit above becomes medium.
    expect(getParkingLod(deltaForZoom(LOD_MEDIUM_MIN_ZOOM - 1), 'low')).toBe('low');
    expect(getParkingLod(deltaForZoom(LOD_MEDIUM_MIN_ZOOM + 1), 'low')).toBe('medium');
  });

  it('crosses medium → high exactly at LOD_HIGH_MIN_ZOOM', () => {
    expect(getParkingLod(deltaForZoom(LOD_HIGH_MIN_ZOOM - 1), 'medium')).toBe('medium');
    expect(getParkingLod(deltaForZoom(LOD_HIGH_MIN_ZOOM + 1), 'medium')).toBe('high');
  });

  it('applies hysteresis so a zoom on a boundary keeps the previous level', () => {
    const onHighBoundary = deltaForZoom(LOD_HIGH_MIN_ZOOM);
    // Coming UP from medium: not yet high (needs threshold + margin).
    expect(getParkingLod(onHighBoundary, 'medium')).toBe('medium');
    // Coming DOWN from high: still high (needs threshold - margin to drop).
    expect(getParkingLod(onHighBoundary, 'high')).toBe('high');
  });

  it('guards against a non-finite delta (transient during camera animation)', () => {
    expect(zoomFromDelta(0)).toBe(14);
    expect(Number.isFinite(zoomFromDelta(NaN))).toBe(true);
    // z=14 sits just under the medium boundary+hysteresis → stays low from low.
    expect(getParkingLod(0, 'low')).toBe('low');
  });
});
