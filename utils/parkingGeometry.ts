import { LatLng } from '../types/parking';
import { simplifyCoords } from './geo';

// ─── Cached parking-zone geometry simplification ──────────────────────────────
// Simplifying an OSM ring (Ramer–Douglas–Peucker) on every React render is
// wasteful — the same geometry always produces the same result. We cache by the
// ORIGINAL coordinate-array reference, which is stable per parking until its
// geometry is re-fetched (the session cache only ever swaps the array when new
// geometry arrives). A WeakMap lets entries be garbage-collected automatically
// once a parking object drops out of the cache.
//
// Scope: this module is used ONLY for parking-zone rendering. The tolerance is
// fixed (medium-LOD), so a single cached result per input array is correct.

const simplifiedCache = new WeakMap<LatLng[], LatLng[]>();

/**
 * Simplified copy of a parking-zone ring/line for MEDIUM-zoom rendering.
 *
 * - Never mutates the input (RDP returns a new array; the original is untouched).
 * - Caches by input reference, so it runs at most once per geometry.
 * - `minPoints` guards validity: a closed polygon ring needs ≥ 4 points
 *   (3 unique + the closing point); an open polyline needs ≥ 2. If
 *   simplification would drop below that, we fall back to the ORIGINAL geometry
 *   rather than emit an invalid shape.
 */
export const simplifiedZoneGeometry = (
  coords: LatLng[],
  toleranceMeters: number,
  minPoints: number,
): LatLng[] => {
  const cached = simplifiedCache.get(coords);
  if (cached) return cached;

  let result = coords;
  if (coords.length > minPoints) {
    const simplified = simplifyCoords(coords, toleranceMeters);
    // Fall back to the original if RDP collapsed the shape below a valid count.
    result = simplified.length >= minPoints ? simplified : coords;
  }
  simplifiedCache.set(coords, result);
  return result;
};
