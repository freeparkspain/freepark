import { LatLng } from '../../types/parking';
import { isValidCoordinate } from './routeValidator';

// ─── Route progress splitting (pure) ──────────────────────────────────────────
// Splits the route into "completed" (behind the arrow) and "remaining" (ahead)
// at the matched position, WITHOUT mutating the source array and without
// scanning/allocating more than a couple of slices.

export interface RouteSplit {
  completed: LatLng[];
  remaining: LatLng[];
}

export interface MatchPoint {
  segmentIndex: number;
  position:     LatLng;
}

/**
 * @param coords full route polyline (already sanitized)
 * @param match  the arrow's matched position + owning segment (null before the
 *               first fix → everything is "remaining")
 */
export function splitRouteByProgress(coords: LatLng[], match: MatchPoint | null): RouteSplit {
  if (coords.length < 2) {
    return { completed: [], remaining: coords.slice() };
  }
  if (!match || !isValidCoordinate(match.position)) {
    return { completed: [], remaining: coords };
  }

  const seg = Math.max(0, Math.min(match.segmentIndex, coords.length - 2));
  const p = match.position;

  // completed = vertices up to and including segment start, then the split point.
  const completed = coords.slice(0, seg + 1);
  completed.push(p);

  // remaining = split point, then the rest of the route.
  const remaining = coords.slice(seg + 1);
  remaining.unshift(p);

  return { completed, remaining };
}
