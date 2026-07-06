import { splitRouteByProgress } from '../navigation/services/routeProgress';
import { LatLng } from '../types/parking';

const coords: LatLng[] = [
  { latitude: 40, longitude: 0.000 },
  { latitude: 40, longitude: 0.003 },
  { latitude: 40, longitude: 0.006 },
  { latitude: 40, longitude: 0.009 },
];

describe('splitRouteByProgress', () => {
  it('puts everything in "remaining" before the first match', () => {
    const s = splitRouteByProgress(coords, null);
    expect(s.completed).toEqual([]);
    expect(s.remaining).toBe(coords); // same reference, not mutated
  });

  it('splits at the matched point on a mid segment', () => {
    const p = { latitude: 40, longitude: 0.0045 }; // middle of segment index 1
    const s = splitRouteByProgress(coords, { segmentIndex: 1, position: p });
    // completed ends AT the split point; remaining starts AT it.
    expect(s.completed[s.completed.length - 1]).toEqual(p);
    expect(s.remaining[0]).toEqual(p);
    // Continuity: the two halves share exactly the split point.
    expect(s.completed).toEqual([coords[0], coords[1], p]);
    expect(s.remaining).toEqual([p, coords[2], coords[3]]);
  });

  it('does not mutate the source array', () => {
    const before = coords.slice();
    splitRouteByProgress(coords, { segmentIndex: 2, position: { latitude: 40, longitude: 0.007 } });
    expect(coords).toEqual(before);
  });

  it('clamps an out-of-range segment index safely', () => {
    const s = splitRouteByProgress(coords, { segmentIndex: 99, position: coords[3] });
    expect(s.remaining.length).toBeGreaterThanOrEqual(1);
    expect(s.completed.length).toBeGreaterThanOrEqual(2);
  });

  it('falls back to all-remaining when the match position is invalid', () => {
    const s = splitRouteByProgress(coords, { segmentIndex: 1, position: { latitude: NaN, longitude: 0 } });
    expect(s.completed).toEqual([]);
    expect(s.remaining).toBe(coords);
  });

  it('handles a degenerate route', () => {
    const s = splitRouteByProgress([{ latitude: 40, longitude: 0 }], null);
    expect(s.remaining).toHaveLength(1);
    expect(s.completed).toEqual([]);
  });
});
