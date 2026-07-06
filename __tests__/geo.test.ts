import { deltaToZoom, simplifyCoords } from '../utils/geo';
import { LatLng } from '../types/parking';

describe('deltaToZoom (crash guard)', () => {
  it('returns a finite zoom for normal deltas', () => {
    expect(Number.isFinite(deltaToZoom(0.09))).toBe(true);
    expect(deltaToZoom(0.09)).toBeGreaterThan(10);
  });

  it('never returns NaN/Infinity for degenerate deltas (0 / negative / NaN)', () => {
    // These transient values appear during camera animations; a NaN zoom used
    // to crash Supercluster.getClusters().
    expect(Number.isFinite(deltaToZoom(0))).toBe(true);
    expect(Number.isFinite(deltaToZoom(-1))).toBe(true);
    expect(Number.isFinite(deltaToZoom(NaN))).toBe(true);
  });
});

describe('simplifyCoords (route render simplification)', () => {
  it('reduces point count while preserving endpoints', () => {
    const line: LatLng[] = [];
    for (let i = 0; i <= 100; i++) {
      // A gently curving line with lots of near-collinear points.
      line.push({ latitude: 40 + i * 0.0001, longitude: -4 + Math.sin(i / 20) * 0.0002 });
    }
    const simplified = simplifyCoords(line, 5);
    expect(simplified.length).toBeLessThan(line.length);
    expect(simplified[0]).toEqual(line[0]);
    expect(simplified[simplified.length - 1]).toEqual(line[line.length - 1]);
  });

  it('leaves short lines untouched', () => {
    const two: LatLng[] = [
      { latitude: 40, longitude: -4 },
      { latitude: 41, longitude: -3 },
    ];
    expect(simplifyCoords(two, 5)).toHaveLength(2);
  });
});
