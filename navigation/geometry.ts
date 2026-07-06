import { LatLng } from '../types/parking';
import { haversineDistance } from '../utils/geo';

// ─── Route geometry math (pure) ───────────────────────────────────────────────
// Local equirectangular projection to metres for point-to-segment work: for the
// short segments a decoded route is made of, treating a small patch of the globe
// as flat (with longitude scaled by cos(lat)) is accurate to well under a metre
// — far below GPS noise — and avoids expensive per-point haversine in the hot
// projection loop. Absolute distances still use haversine.

const M_PER_DEG_LAT = 111_320;

interface Vec2 { x: number; y: number }

function toMeters(p: LatLng, refLatDeg: number): Vec2 {
  const mPerDegLon = M_PER_DEG_LAT * Math.cos((refLatDeg * Math.PI) / 180);
  return { x: p.longitude * mPerDegLon, y: p.latitude * M_PER_DEG_LAT };
}

export interface ProjectionResult {
  /** Index of the segment start vertex the point projects onto. */
  segmentIndex:      number;
  /** Interpolation factor [0,1] along that segment. */
  t:                 number;
  /** Nearest point on the polyline. */
  snapped:           LatLng;
  /** Perpendicular distance from the input point to the polyline (metres). */
  distanceMeters:    number;
  /** Distance from the start of the polyline to `snapped`, along the path (metres). */
  alongMeters:       number;
}

/** Cumulative along-path distance to each vertex (metres). Length == points.length. */
export function cumulativeDistances(points: LatLng[]): number[] {
  const cum: number[] = new Array(points.length);
  cum[0] = 0;
  for (let i = 1; i < points.length; i++) {
    cum[i] = cum[i - 1] + haversineDistance(points[i - 1], points[i]);
  }
  return cum;
}

/** Closest point on segment [a,b] to p, with the interpolation factor t∈[0,1]. */
export function projectOnSegment(
  p: LatLng,
  a: LatLng,
  b: LatLng,
): { snapped: LatLng; t: number; distanceMeters: number } {
  const refLat = p.latitude;
  const pv = toMeters(p, refLat);
  const av = toMeters(a, refLat);
  const bv = toMeters(b, refLat);

  const abx = bv.x - av.x;
  const aby = bv.y - av.y;
  const lenSq = abx * abx + aby * aby;

  let t = 0;
  if (lenSq > 1e-9) {
    t = ((pv.x - av.x) * abx + (pv.y - av.y) * aby) / lenSq;
    if (t < 0) t = 0;
    else if (t > 1) t = 1;
  }

  const snapped: LatLng = {
    latitude:  a.latitude  + t * (b.latitude  - a.latitude),
    longitude: a.longitude + t * (b.longitude - a.longitude),
  };
  return { snapped, t, distanceMeters: haversineDistance(p, snapped) };
}

/**
 * Project `p` onto the whole polyline, returning the nearest segment, the
 * snapped point, the perpendicular distance and the along-path distance.
 * O(n) over the route — fine at ~1 Hz GPS for city routes.
 */
export function projectOnPath(
  p: LatLng,
  points: LatLng[],
  cumulative?: number[],
): ProjectionResult {
  if (points.length === 0) {
    return { segmentIndex: 0, t: 0, snapped: p, distanceMeters: 0, alongMeters: 0 };
  }
  if (points.length === 1) {
    return {
      segmentIndex: 0, t: 0, snapped: points[0],
      distanceMeters: haversineDistance(p, points[0]), alongMeters: 0,
    };
  }

  const cum = cumulative ?? cumulativeDistances(points);
  let best: ProjectionResult | null = null;

  for (let i = 0; i < points.length - 1; i++) {
    const { snapped, t, distanceMeters } = projectOnSegment(p, points[i], points[i + 1]);
    if (!best || distanceMeters < best.distanceMeters) {
      const segLen = cum[i + 1] - cum[i];
      best = {
        segmentIndex:   i,
        t,
        snapped,
        distanceMeters,
        alongMeters:    cum[i] + t * segLen,
      };
    }
  }

  return best!;
}
