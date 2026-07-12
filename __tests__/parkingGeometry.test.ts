import { simplifiedZoneGeometry } from '../utils/parkingGeometry';
import { LatLng } from '../types/parking';

describe('simplifiedZoneGeometry (cached parking-zone RDP)', () => {
  // A closed square ring with a redundant collinear midpoint on the bottom edge.
  const ring: LatLng[] = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.5 }, // collinear midpoint — should be dropped
    { latitude: 0, longitude: 1 },
    { latitude: 1, longitude: 1 },
    { latitude: 1, longitude: 0 },
    { latitude: 0, longitude: 0 }, // closing point
  ];

  it('reduces the vertex count while preserving the closed ring', () => {
    const out = simplifiedZoneGeometry(ring, 6, 4);
    expect(out.length).toBeLessThan(ring.length);
    expect(out.length).toBeGreaterThanOrEqual(4); // still a valid polygon
    expect(out[0]).toEqual(out[out.length - 1]);   // still closed
  });

  it('never mutates the input geometry', () => {
    const lengthBefore = ring.length;
    const first = { ...ring[0] };
    simplifiedZoneGeometry(ring, 6, 4);
    expect(ring.length).toBe(lengthBefore);
    expect(ring[0]).toEqual(first);
  });

  it('returns the same cached reference on repeat calls (no re-simplification)', () => {
    const a = simplifiedZoneGeometry(ring, 6, 4);
    const b = simplifiedZoneGeometry(ring, 6, 4);
    expect(b).toBe(a);
  });

  it('falls back to the original when the input is already minimal', () => {
    const line: LatLng[] = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    ];
    // length (2) is not > minPoints (2) → returns the original reference.
    expect(simplifiedZoneGeometry(line, 6, 2)).toBe(line);
  });
});
