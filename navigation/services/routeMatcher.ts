import { LatLng } from '../../types/parking';
import { CarTrackingConfig, MatchedLocation } from '../../types/navigation';
import { haversineDistance } from '../../utils/geo';
import { projectOnSegment } from '../geometry';
import { segmentBearing } from './bearing';

// ─── Route matcher (pure, framework-free) ─────────────────────────────────────
// Snaps a raw GPS point onto the active route so the car stays on the road,
// while tracking forward progress. Searches only a WINDOW around the current
// segment (not the whole route every tick) to stay O(window) and to avoid
// snapping to a distant parallel road or jumping back to an earlier pass.

export interface RouteIndex {
  coords:     LatLng[];
  /** Cumulative along-route distance to each vertex (metres). */
  cumulative: number[];
}

/** Precompute cumulative distances once per route (reused across GPS ticks). */
export function buildRouteIndex(coords: LatLng[]): RouteIndex {
  const cumulative = new Array(coords.length);
  cumulative[0] = 0;
  for (let i = 1; i < coords.length; i++) {
    cumulative[i] = cumulative[i - 1] + haversineDistance(coords[i - 1], coords[i]);
  }
  return { coords, cumulative };
}

export interface PrevMatch {
  progressMeters: number;
  segmentIndex:   number;
}

/** Position + owning segment at a given along-route distance. */
export function positionAtDistance(
  index: RouteIndex,
  meters: number,
): { position: LatLng; segmentIndex: number } {
  const { coords, cumulative } = index;
  const last = coords.length - 1;
  if (meters <= 0) return { position: coords[0], segmentIndex: 0 };
  if (meters >= cumulative[last]) return { position: coords[last], segmentIndex: Math.max(0, last - 1) };

  // Linear scan is fine for the modest vertex counts of a city route.
  let i = 0;
  while (i < last - 1 && cumulative[i + 1] <= meters) i++;
  const segLen = cumulative[i + 1] - cumulative[i];
  const t = segLen > 0 ? (meters - cumulative[i]) / segLen : 0;
  return {
    position: {
      latitude:  coords[i].latitude  + t * (coords[i + 1].latitude  - coords[i].latitude),
      longitude: coords[i].longitude + t * (coords[i + 1].longitude - coords[i].longitude),
    },
    segmentIndex: i,
  };
}

/**
 * Match `raw` onto the route.
 * - Windowed search around `prev.segmentIndex` (falls back to full route on first match).
 * - Snaps only within `maximumSnapDistanceMeters` (else keeps the raw position).
 * - Rejects large backward jumps (holds previous progress) to prevent snapping
 *   to an earlier part of the route on parallel/overlapping roads.
 */
export function matchToRoute(
  index: RouteIndex,
  raw: LatLng,
  prev: PrevMatch | null,
  config: CarTrackingConfig,
): MatchedLocation {
  const { coords, cumulative } = index;
  const lastSeg = coords.length - 2;

  if (coords.length < 2) {
    return {
      rawPosition: raw, matchedPosition: raw, distanceFromRouteMeters: 0,
      routeSegmentIndex: 0, routeProgressMeters: 0,
      bearing: 0, isSnappedToRoute: false,
    };
  }

  const startSeg = prev ? Math.max(0, prev.segmentIndex - config.searchSegmentsBehind) : 0;
  const endSeg   = prev ? Math.min(lastSeg, prev.segmentIndex + config.searchSegmentsAhead) : lastSeg;

  let bestI = startSeg;
  let bestT = 0;
  let bestSnap = coords[startSeg];
  let bestDist = Infinity;

  for (let i = startSeg; i <= endSeg; i++) {
    const proj = projectOnSegment(raw, coords[i], coords[i + 1]);
    if (proj.distanceMeters < bestDist) {
      bestDist = proj.distanceMeters;
      bestI = i;
      bestT = proj.t;
      bestSnap = proj.snapped;
    }
  }

  let segIndex = bestI;
  let matchedSnap = bestSnap;
  let dist = bestDist;
  let progress = cumulative[bestI] + bestT * (cumulative[bestI + 1] - cumulative[bestI]);

  // Guard against a big backward jump — hold at the previous progress instead
  // of snapping to an earlier, parallel part of the route.
  if (prev && progress < prev.progressMeters - config.maximumBackwardProgressMeters) {
    const held = positionAtDistance(index, prev.progressMeters);
    progress = prev.progressMeters;
    segIndex = held.segmentIndex;
    matchedSnap = held.position;
    dist = haversineDistance(raw, held.position);
  }

  const isSnapped = dist <= config.maximumSnapDistanceMeters;
  return {
    rawPosition:             raw,
    matchedPosition:         isSnapped ? matchedSnap : raw,
    distanceFromRouteMeters: dist,
    routeSegmentIndex:       segIndex,
    routeProgressMeters:     progress,
    bearing:                 segmentBearing(coords[segIndex], coords[segIndex + 1]),
    isSnappedToRoute:        isSnapped,
  };
}

/** Bearing of the first route segment — a recenter fallback before the car moves. */
export function firstSegmentBearing(coords: LatLng[]): number | null {
  if (coords.length < 2) return null;
  return segmentBearing(coords[0], coords[1]);
}
