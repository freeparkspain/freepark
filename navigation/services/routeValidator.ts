import { LatLng } from '../../types/parking';
import type { NavigationRoute } from '../../types/navigation';
import { haversineDistance } from '../../utils/geo';

// ─── Route validation (pure, framework-free) ──────────────────────────────────
// Guards the map against the crash-prone inputs a routing response can carry:
// NaN/Infinity, nulls, reversed or out-of-range lat/lng, empty arrays, and
// degenerate geometry. Everything the UI renders (polylines, camera bounds)
// passes through here first.

/** True only for a finite lat/lng inside valid geographic ranges. */
export function isValidCoordinate(value: unknown): value is LatLng {
  if (!value || typeof value !== 'object') return false;
  const c = value as Partial<LatLng>;
  return (
    Number.isFinite(c.latitude) &&
    Number.isFinite(c.longitude) &&
    (c.latitude as number) >= -90 &&
    (c.latitude as number) <= 90 &&
    (c.longitude as number) >= -180 &&
    (c.longitude as number) <= 180
  );
}

const EPS = 1e-7;

function samePoint(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.latitude - b.latitude) < EPS && Math.abs(a.longitude - b.longitude) < EPS;
}

/**
 * Keep only valid coordinates and drop consecutive duplicates (which produce
 * zero-length segments that break bearing math and can crash native polylines).
 */
export function sanitizeRouteCoordinates(coords: unknown): LatLng[] {
  if (!Array.isArray(coords)) return [];
  const out: LatLng[] = [];
  for (const raw of coords) {
    if (!isValidCoordinate(raw)) continue;
    const point: LatLng = { latitude: raw.latitude, longitude: raw.longitude };
    if (out.length === 0 || !samePoint(out[out.length - 1], point)) {
      out.push(point);
    }
  }
  return out;
}

export interface RouteValidation {
  ok:     boolean;
  reason: string | null;
  /** Sanitized coordinates (present when ok). */
  coordinates: LatLng[];
}

/**
 * Validate a full route geometry: at least two valid points and non-zero length.
 * Returns an English reason on failure so callers can surface it directly.
 */
export function validateRouteGeometry(coords: unknown): RouteValidation {
  const sanitized = sanitizeRouteCoordinates(coords);
  if (sanitized.length < 2) {
    return { ok: false, reason: 'The route data is invalid.', coordinates: [] };
  }
  let length = 0;
  for (let i = 1; i < sanitized.length; i++) {
    length += haversineDistance(sanitized[i - 1], sanitized[i]);
  }
  if (!(length > 0)) {
    return { ok: false, reason: 'The route data is invalid.', coordinates: [] };
  }
  return { ok: true, reason: null, coordinates: sanitized };
}

/** A preview route is safe to reuse when turn-by-turn navigation starts. */
export function isUsablePreparedNavigationRoute(
  route: NavigationRoute | null | undefined,
): route is NavigationRoute {
  return Boolean(
    route &&
    validateRouteGeometry(route.points).ok &&
    route.steps.length > 0 &&
    Number.isFinite(route.totalDistanceMeters) &&
    route.totalDistanceMeters >= 0 &&
    Number.isFinite(route.totalDurationSeconds) &&
    route.totalDurationSeconds >= 0
  );
}

/**
 * True when a bounds box is finite and non-degenerate — used before calling
 * camera fit methods, which crash on NaN/empty bounds.
 */
export function isValidBounds(sw: LatLng, ne: LatLng): boolean {
  return (
    isValidCoordinate(sw) &&
    isValidCoordinate(ne) &&
    ne.latitude >= sw.latitude &&
    ne.longitude >= sw.longitude
  );
}
