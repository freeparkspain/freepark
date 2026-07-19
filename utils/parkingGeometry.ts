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
const EARTH_RADIUS_METERS = 6_371_000;
const STREET_OFFSET_METERS = 4.2;
const COORDINATE_EPSILON_METERS = 0.05;

export type ParkingRenderSide = 'left' | 'right' | 'center';

export interface ParkingRenderLine {
  side: ParkingRenderSide;
  coordinates: LatLng[];
}

export interface ParkingRenderGeometry {
  polygon: LatLng[] | null;
  lines: ParkingRenderLine[];
}

interface XY {
  x: number;
  y: number;
}

const isFiniteCoordinate = (point: LatLng): boolean =>
  Number.isFinite(point.latitude) && Number.isFinite(point.longitude) &&
  Math.abs(point.latitude) <= 90 && Math.abs(point.longitude) <= 180;

const coordinateDistanceMeters = (a: LatLng, b: LatLng): number => {
  const latitudeScale = Math.PI * EARTH_RADIUS_METERS / 180;
  const meanLatitude = ((a.latitude + b.latitude) / 2) * Math.PI / 180;
  const dx = (b.longitude - a.longitude) * latitudeScale * Math.cos(meanLatitude);
  const dy = (b.latitude - a.latitude) * latitudeScale;
  return Math.hypot(dx, dy);
};

function projectionFor(path: LatLng[]) {
  const origin = path[0];
  const meanLatitude = path.reduce((sum, point) => sum + point.latitude, 0) / path.length;
  const cosLatitude = Math.max(1e-6, Math.cos(meanLatitude * Math.PI / 180));
  return {
    toXY: (point: LatLng): XY => ({
      x: (point.longitude - origin.longitude) * Math.PI / 180 * EARTH_RADIUS_METERS * cosLatitude,
      y: (point.latitude - origin.latitude) * Math.PI / 180 * EARTH_RADIUS_METERS,
    }),
    toCoordinate: (point: XY): LatLng => ({
      latitude: origin.latitude + point.y / EARTH_RADIUS_METERS * 180 / Math.PI,
      longitude: origin.longitude + point.x / (EARTH_RADIUS_METERS * cosLatitude) * 180 / Math.PI,
    }),
  };
}

function cleanPath(path: LatLng[]): LatLng[] {
  const cleaned: LatLng[] = [];
  for (const point of path) {
    if (!isFiniteCoordinate(point)) return [];
    if (
      cleaned.length === 0 ||
      coordinateDistanceMeters(cleaned[cleaned.length - 1], point) >= COORDINATE_EPSILON_METERS
    ) cleaned.push(point);
  }
  return cleaned;
}

export function expandStreetParkingSides(tags: Record<string, string>): Array<'left' | 'right'> {
  const sides = (tags.__parking_sides ?? '').split(',').map(side => side.trim());
  if (sides.includes('both')) return ['left', 'right'];
  const result: Array<'left' | 'right'> = [];
  if (sides.includes('left')) result.push('left');
  if (sides.includes('right')) result.push('right');
  return result;
}

/** Offset an OSM way to its visual left/right in a local metre projection. */
export function offsetPolylineMeters(path: LatLng[], signedMeters: number): LatLng[] {
  const cleaned = cleanPath(path);
  if (cleaned.length < 2 || !Number.isFinite(signedMeters)) return [];

  const closed = cleaned.length > 2 &&
    coordinateDistanceMeters(cleaned[0], cleaned[cleaned.length - 1]) < 0.5;
  const source = closed ? cleaned.slice(0, -1) : cleaned;
  if (source.length < 2) return [];

  const projection = projectionFor(source);
  const points = source.map(projection.toXY);
  const segmentCount = closed ? points.length : points.length - 1;
  const normals: XY[] = [];
  for (let index = 0; index < segmentCount; index += 1) {
    const nextIndex = (index + 1) % points.length;
    const dx = points[nextIndex].x - points[index].x;
    const dy = points[nextIndex].y - points[index].y;
    const length = Math.hypot(dx, dy);
    if (length < 1e-6) return [];
    normals.push({ x: -dy / length, y: dx / length });
  }

  const offsetPoints = points.map((point, index) => {
    const previousNormal = closed
      ? normals[(index - 1 + normals.length) % normals.length]
      : normals[Math.max(0, index - 1)];
    const nextNormal = closed
      ? normals[index % normals.length]
      : normals[Math.min(normals.length - 1, index)];
    const sumX = previousNormal.x + nextNormal.x;
    const sumY = previousNormal.y + nextNormal.y;
    const sumLength = Math.hypot(sumX, sumY);
    const miter = sumLength > 1e-6
      ? { x: sumX / sumLength, y: sumY / sumLength }
      : nextNormal;
    const denominator = Math.abs(miter.x * nextNormal.x + miter.y * nextNormal.y);
    const rawScale = denominator > 0.25 ? signedMeters / denominator : signedMeters;
    const maxScale = Math.abs(signedMeters) * 2;
    const scale = Math.max(-maxScale, Math.min(maxScale, rawScale));
    return projection.toCoordinate({ x: point.x + miter.x * scale, y: point.y + miter.y * scale });
  });

  if (closed) offsetPoints.push({ ...offsetPoints[0] });
  return offsetPoints;
}

export function buildStreetParkingPaths(
  centerline: LatLng[],
  tags: Record<string, string>,
  offsetMeters = STREET_OFFSET_METERS,
): ParkingRenderLine[] {
  const sides = expandStreetParkingSides(tags);
  if (sides.length === 0) {
    const cleaned = cleanPath(centerline);
    return cleaned.length >= 2 ? [{ side: 'center', coordinates: cleaned }] : [];
  }
  return sides.flatMap(side => {
    const coordinates = offsetPolylineMeters(
      centerline,
      side === 'left' ? offsetMeters : -offsetMeters,
    );
    return coordinates.length >= 2 ? [{ side, coordinates }] : [];
  });
}

function polygonMetrics(ring: LatLng[]): { area: number; perimeter: number } | null {
  const cleaned = cleanPath(ring);
  if (cleaned.length < 4 || coordinateDistanceMeters(cleaned[0], cleaned[cleaned.length - 1]) > 0.75) {
    return null;
  }
  const source = cleaned.slice(0, -1);
  if (source.length < 3) return null;
  const projection = projectionFor(source);
  const points = source.map(projection.toXY);
  let twiceArea = 0;
  let perimeter = 0;
  for (let index = 0; index < points.length; index += 1) {
    const next = points[(index + 1) % points.length];
    twiceArea += points[index].x * next.y - next.x * points[index].y;
    perimeter += Math.hypot(next.x - points[index].x, next.y - points[index].y);
  }
  const area = Math.abs(twiceArea) / 2;
  return area >= 3 && perimeter > 0 ? { area, perimeter } : null;
}

/** One rendering contract for unselected and selected parking geometry. */
export function parkingRenderGeometry(
  tags: Record<string, string>,
  polygon: LatLng[] | null,
  polyline: LatLng[] | null,
): ParkingRenderGeometry {
  if (tags.__parking_geometry === 'street') {
    const centerline = polyline ?? polygon;
    return {
      polygon: null,
      lines: centerline ? buildStreetParkingPaths(centerline, tags) : [],
    };
  }

  if (polygon) {
    const metrics = polygonMetrics(polygon);
    if (!metrics) return { polygon: null, lines: [] };
    return { polygon, lines: [] };
  }

  const cleaned = polyline ? cleanPath(polyline) : [];
  return {
    polygon: null,
    lines: cleaned.length >= 2 ? [{ side: 'center', coordinates: cleaned }] : [],
  };
}

/** Closed highway ways with side-parking tags are still street centerlines. */
export function normalizeGeometryForParkingTags(
  tags: Record<string, string>,
  polygon: LatLng[] | null,
  polyline: LatLng[] | null,
): { polygon: LatLng[] | null; polyline: LatLng[] | null } {
  if (tags.__parking_geometry !== 'street') return { polygon, polyline };
  return { polygon: null, polyline: polyline ?? polygon };
}

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

/**
 * Simplify an already-built render geometry (polygon ring / offset street
 * lines) for MEDIUM-zoom rendering.
 *
 * MUST be applied AFTER `parkingRenderGeometry`, never before — simplifying
 * the raw OSM centerline first and THEN offsetting it (the previous order)
 * fed a coarsened path into `offsetPolylineMeters`'s miter-join math. Collapsing
 * a rounded street corner down to just its two endpoints turns a gentle curve
 * into a single sharp vertex that never existed in the real geometry, and the
 * miter join at a sharp vertex can push the offset point up to 2× the intended
 * distance in the wrong direction — the "zone geometry breaks when you zoom
 * out" artifact (clean at high LOD/full-res, spiky/self-crossing at medium
 * LOD/simplified). Simplifying the already-offset line instead only ever
 * DROPS points that were already correctly offset, so it can never introduce a
 * position that wasn't a real point on the true parallel line.
 */
export function simplifyRenderGeometry(
  geometry: ParkingRenderGeometry,
  toleranceMeters: number,
): ParkingRenderGeometry {
  return {
    polygon: geometry.polygon
      ? simplifiedZoneGeometry(geometry.polygon, toleranceMeters, 4)
      : null,
    lines: geometry.lines.map(line => ({
      side: line.side,
      coordinates: simplifiedZoneGeometry(line.coordinates, toleranceMeters, 2),
    })),
  };
}
