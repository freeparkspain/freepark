import type { LatLng } from '../types/parking';

/** The shape used to present a parking object on the map. */
export type ParkingGeometryKind = 'point' | 'street' | 'area';

export type ParkingAccessSource =
  | 'polygon-center'
  | 'explicit-entrance'
  | 'service-intersection'
  | 'service-nearest'
  | 'street-endpoint'
  | 'boundary-fallback'
  | 'parking-position';

export interface ParkingAccessGeometry {
  position?: LatLng | null;
  polygon?: readonly LatLng[] | null;
  polyline?: readonly LatLng[] | null;
}

/**
 * Inputs are intentionally plain coordinates so this module can be used by the
 * Overpass parser, MapScreen and tests without importing React Native or maps.
 */
export interface ParkingAccessInput extends ParkingAccessGeometry {
  /** Nearby, drivable OSM parking_entrance nodes from the selected context. */
  explicitEntrances?: readonly LatLng[] | null;
  /** Nearby service/parking-aisle road geometries. */
  serviceWays?: readonly (readonly LatLng[])[] | null;
  /** Usually the user's location; also controls deterministic fallback choice. */
  reference?: LatLng | null;
  /** Ignore unrelated service roads farther from the parking boundary. */
  serviceSnapToleranceMeters?: number;
  /** Coordinates closer than this are treated as the same access point. */
  dedupeToleranceMeters?: number;
}

export interface ParkingAccessCandidate {
  position: LatLng;
  source: ParkingAccessSource;
  priority: number;
}

export const PARKING_ACCESS_PRIORITY: Readonly<Record<ParkingAccessSource, number>> = {
  'polygon-center': -10,
  'explicit-entrance': 0,
  'service-intersection': 10,
  'service-nearest': 20,
  'street-endpoint': 30,
  'boundary-fallback': 40,
  'parking-position': 50,
};

const EARTH_RADIUS_METERS = 6_371_000;
const DEFAULT_SERVICE_SNAP_METERS = 35;
const DEFAULT_DEDUPE_METERS = 0.75;
const MAX_AREA_ENTRANCE_BOUNDARY_METERS = 20;
const MAX_POINT_ENTRANCE_DISTANCE_METERS = 30;
const SEGMENT_EPSILON = 1e-12;

const sourceOrder: Readonly<Record<ParkingAccessSource, number>> = {
  'polygon-center': 0,
  'explicit-entrance': 1,
  'service-intersection': 2,
  'service-nearest': 3,
  'street-endpoint': 4,
  'boundary-fallback': 5,
  'parking-position': 6,
};

/** Runtime-safe coordinate guard for data coming from OSM or cached JSON. */
export const isFiniteParkingCoordinate = (value: unknown): value is LatLng => {
  if (typeof value !== 'object' || value === null) return false;
  const coordinate = value as Partial<LatLng>;
  return (
    typeof coordinate.latitude === 'number' &&
    Number.isFinite(coordinate.latitude) &&
    coordinate.latitude >= -90 &&
    coordinate.latitude <= 90 &&
    typeof coordinate.longitude === 'number' &&
    Number.isFinite(coordinate.longitude) &&
    coordinate.longitude >= -180 &&
    coordinate.longitude <= 180
  );
};

const distanceMeters = (a: LatLng, b: LatLng): number => {
  const toRadians = (degrees: number) => (degrees * Math.PI) / 180;
  const latitudeDelta = toRadians(b.latitude - a.latitude);
  const longitudeDelta = toRadians(b.longitude - a.longitude);
  const sinLatitude = Math.sin(latitudeDelta / 2);
  const sinLongitude = Math.sin(longitudeDelta / 2);
  const chord =
    sinLatitude * sinLatitude +
    Math.cos(toRadians(a.latitude)) *
      Math.cos(toRadians(b.latitude)) *
      sinLongitude * sinLongitude;
  return 2 * EARTH_RADIUS_METERS * Math.atan2(Math.sqrt(chord), Math.sqrt(Math.max(0, 1 - chord)));
};

const interpolate = (a: LatLng, b: LatLng, fraction: number): LatLng => ({
  latitude: a.latitude + (b.latitude - a.latitude) * fraction,
  longitude: a.longitude + (b.longitude - a.longitude) * fraction,
});

const sameCoordinate = (a: LatLng, b: LatLng): boolean =>
  Math.abs(a.latitude - b.latitude) < 1e-12 &&
  Math.abs(a.longitude - b.longitude) < 1e-12;

const validPath = (path: readonly LatLng[] | null | undefined): LatLng[] => {
  if (!Array.isArray(path)) return [];
  const result: LatLng[] = [];
  for (const value of path as readonly unknown[]) {
    if (!isFiniteParkingCoordinate(value)) continue;
    const coordinate = { latitude: value.latitude, longitude: value.longitude };
    if (result.length === 0 || !sameCoordinate(result[result.length - 1], coordinate)) {
      result.push(coordinate);
    }
  }
  return result;
};

const uniqueCoordinateCount = (path: readonly LatLng[]): number => {
  const unique: LatLng[] = [];
  for (const coordinate of path) {
    if (!unique.some(existing => distanceMeters(existing, coordinate) < 0.05)) {
      unique.push(coordinate);
    }
  }
  return unique.length;
};

const polygonHasArea = (polygon: readonly LatLng[]): boolean => {
  if (uniqueCoordinateCount(polygon) < 3) return false;
  let twiceArea = 0;
  for (let index = 0; index < polygon.length; index += 1) {
    const current = polygon[index];
    const next = polygon[(index + 1) % polygon.length];
    twiceArea += current.longitude * next.latitude - next.longitude * current.latitude;
  }
  return Math.abs(twiceArea) > 1e-14;
};

/** Area-weighted geometric centre of a valid parking polygon. */
export const parkingPolygonCenter = (
  rawPolygon: readonly LatLng[] | null | undefined,
): LatLng | null => {
  const polygon = validPath(rawPolygon);
  if (!polygonHasArea(polygon)) return null;
  const vertices = polygon.length > 1 && sameCoordinate(polygon[0], polygon[polygon.length - 1])
    ? polygon.slice(0, -1)
    : polygon;
  if (vertices.length < 3) return null;

  const origin = vertices[0];
  let twiceArea = 0;
  let longitudeNumerator = 0;
  let latitudeNumerator = 0;
  for (let index = 0; index < vertices.length; index += 1) {
    const current = vertices[index];
    const next = vertices[(index + 1) % vertices.length];
    const currentLongitude = current.longitude - origin.longitude;
    const currentLatitude = current.latitude - origin.latitude;
    const nextLongitude = next.longitude - origin.longitude;
    const nextLatitude = next.latitude - origin.latitude;
    const crossProduct = currentLongitude * nextLatitude - nextLongitude * currentLatitude;
    twiceArea += crossProduct;
    longitudeNumerator += (currentLongitude + nextLongitude) * crossProduct;
    latitudeNumerator += (currentLatitude + nextLatitude) * crossProduct;
  }
  if (Math.abs(twiceArea) <= 1e-18) return null;

  const center = {
    latitude: origin.latitude + latitudeNumerator / (3 * twiceArea),
    longitude: origin.longitude + longitudeNumerator / (3 * twiceArea),
  };
  return isFiniteParkingCoordinate(center) ? center : null;
};

/** Classify semantic parking geometry, tolerating malformed cached coordinates. */
export const classifyParkingGeometry = (geometry: ParkingAccessGeometry): ParkingGeometryKind => {
  const polygon = validPath(geometry.polygon);
  if (polygonHasArea(polygon)) return 'area';
  const polyline = validPath(geometry.polyline);
  if (uniqueCoordinateCount(polyline) >= 2) return 'street';
  return 'point';
};

interface Segment {
  a: LatLng;
  b: LatLng;
}

const pathSegments = (path: readonly LatLng[], close: boolean): Segment[] => {
  const segments: Segment[] = [];
  for (let index = 0; index < path.length - 1; index += 1) {
    if (!sameCoordinate(path[index], path[index + 1])) {
      segments.push({ a: path[index], b: path[index + 1] });
    }
  }
  if (close && path.length > 2 && !sameCoordinate(path[path.length - 1], path[0])) {
    segments.push({ a: path[path.length - 1], b: path[0] });
  }
  return segments;
};

/** Projection onto the full segment, not merely its nearest vertex. */
const nearestPointOnSegment = (point: LatLng, segment: Segment): LatLng => {
  const meanLatitudeRadians =
    ((point.latitude + segment.a.latitude + segment.b.latitude) / 3) * (Math.PI / 180);
  const longitudeScale = Math.max(1e-6, Math.cos(meanLatitudeRadians));
  const dx = (segment.b.longitude - segment.a.longitude) * longitudeScale;
  const dy = segment.b.latitude - segment.a.latitude;
  const px = (point.longitude - segment.a.longitude) * longitudeScale;
  const py = point.latitude - segment.a.latitude;
  const squaredLength = dx * dx + dy * dy;
  if (squaredLength < Number.EPSILON) return segment.a;
  const fraction = Math.max(0, Math.min(1, (px * dx + py * dy) / squaredLength));
  return interpolate(segment.a, segment.b, fraction);
};

const nearestPointOnPath = (
  point: LatLng,
  path: readonly LatLng[],
  close: boolean,
): { position: LatLng; distance: number } | null => {
  let best: { position: LatLng; distance: number } | null = null;
  for (const segment of pathSegments(path, close)) {
    const position = nearestPointOnSegment(point, segment);
    const distance = distanceMeters(point, position);
    if (
      !best ||
      distance < best.distance - 1e-6 ||
      (Math.abs(distance - best.distance) <= 1e-6 && comparePosition(position, best.position) < 0)
    ) {
      best = { position, distance };
    }
  }
  return best;
};

const cross = (ax: number, ay: number, bx: number, by: number): number => ax * by - ay * bx;

const segmentIntersections = (first: Segment, second: Segment): LatLng[] => {
  const longitudeScale = Math.max(
    1e-6,
    Math.cos(
      ((first.a.latitude + first.b.latitude + second.a.latitude + second.b.latitude) / 4) *
        (Math.PI / 180),
    ),
  );
  const rx = (first.b.longitude - first.a.longitude) * longitudeScale;
  const ry = first.b.latitude - first.a.latitude;
  const sx = (second.b.longitude - second.a.longitude) * longitudeScale;
  const sy = second.b.latitude - second.a.latitude;
  const qpx = (second.a.longitude - first.a.longitude) * longitudeScale;
  const qpy = second.a.latitude - first.a.latitude;
  const denominator = cross(rx, ry, sx, sy);
  const qCrossR = cross(qpx, qpy, rx, ry);

  if (Math.abs(denominator) > SEGMENT_EPSILON) {
    const firstFraction = cross(qpx, qpy, sx, sy) / denominator;
    const secondFraction = qCrossR / denominator;
    if (
      firstFraction >= -SEGMENT_EPSILON &&
      firstFraction <= 1 + SEGMENT_EPSILON &&
      secondFraction >= -SEGMENT_EPSILON &&
      secondFraction <= 1 + SEGMENT_EPSILON
    ) {
      return [interpolate(first.a, first.b, Math.max(0, Math.min(1, firstFraction)))];
    }
    return [];
  }

  // Parallel but not collinear.
  if (Math.abs(qCrossR) > SEGMENT_EPSILON) return [];

  // Collinear overlaps: their contained endpoints are stable access candidates.
  const endpoints = [first.a, first.b, second.a, second.b];
  return endpoints.filter(candidate => {
    const onFirst = distanceMeters(candidate, nearestPointOnSegment(candidate, first)) < 0.05;
    const onSecond = distanceMeters(candidate, nearestPointOnSegment(candidate, second)) < 0.05;
    return onFirst && onSecond;
  });
};

interface BoundaryServiceResult {
  intersections: LatLng[];
  nearestBoundaryPoint: LatLng | null;
  nearestServicePoint: LatLng | null;
  nearestDistance: number;
}

const comparePosition = (a: LatLng, b: LatLng): number =>
  a.latitude - b.latitude || a.longitude - b.longitude;

const compareNearest = (
  candidate: { position: LatLng; distance: number },
  best: { position: LatLng; distance: number } | null,
): boolean =>
  !best ||
  candidate.distance < best.distance - 1e-6 ||
  (Math.abs(candidate.distance - best.distance) <= 1e-6 &&
    comparePosition(candidate.position, best.position) < 0);

const relateBoundaryToService = (
  boundary: readonly LatLng[],
  boundaryClosed: boolean,
  service: readonly LatLng[],
): BoundaryServiceResult => {
  const boundarySegments = pathSegments(boundary, boundaryClosed);
  const serviceSegments = pathSegments(service, false);
  const intersections: LatLng[] = [];
  let nearest: { position: LatLng; servicePosition: LatLng; distance: number } | null = null;

  for (const boundarySegment of boundarySegments) {
    for (const serviceSegment of serviceSegments) {
      intersections.push(...segmentIntersections(boundarySegment, serviceSegment));
      const candidates = [
        nearestPointOnSegment(serviceSegment.a, boundarySegment),
        nearestPointOnSegment(serviceSegment.b, boundarySegment),
        boundarySegment.a,
        boundarySegment.b,
      ];
      for (const position of candidates) {
        const servicePosition = nearestPointOnSegment(position, serviceSegment);
        const candidate = {
          position,
          servicePosition,
          distance: distanceMeters(position, servicePosition),
        };
        if (compareNearest(candidate, nearest)) nearest = candidate;
      }
    }
  }

  return {
    intersections,
    nearestBoundaryPoint: nearest?.position ?? null,
    nearestServicePoint: nearest?.servicePosition ?? null,
    nearestDistance: nearest?.distance ?? Infinity,
  };
};

const makeCandidate = (position: LatLng, source: ParkingAccessSource): ParkingAccessCandidate => ({
  position: { latitude: position.latitude, longitude: position.longitude },
  source,
  priority: PARKING_ACCESS_PRIORITY[source],
});

const candidateComparator = (reference?: LatLng | null) => {
  const usableReference = isFiniteParkingCoordinate(reference) ? reference : null;
  return (a: ParkingAccessCandidate, b: ParkingAccessCandidate): number => {
    const priorityDifference = a.priority - b.priority;
    if (priorityDifference !== 0) return priorityDifference;
    if (usableReference) {
      const distanceDifference =
        distanceMeters(a.position, usableReference) - distanceMeters(b.position, usableReference);
      if (Math.abs(distanceDifference) > 1e-6) return distanceDifference;
    }
    return sourceOrder[a.source] - sourceOrder[b.source] || comparePosition(a.position, b.position);
  };
};

/**
 * Remove malformed and co-located candidates. The better-priority candidate is
 * retained when an entrance and a derived road intersection describe one spot.
 */
export const dedupeParkingAccessCandidates = (
  candidates: readonly ParkingAccessCandidate[],
  toleranceMeters = DEFAULT_DEDUPE_METERS,
  reference?: LatLng | null,
): ParkingAccessCandidate[] => {
  const tolerance =
    Number.isFinite(toleranceMeters) && toleranceMeters >= 0
      ? toleranceMeters
      : DEFAULT_DEDUPE_METERS;
  const valid = candidates.filter(
    candidate =>
      candidate != null &&
      isFiniteParkingCoordinate(candidate.position) &&
      Number.isFinite(candidate.priority) &&
      candidate.source in PARKING_ACCESS_PRIORITY,
  );
  const sorted = [...valid].sort(candidateComparator(reference));
  const result: ParkingAccessCandidate[] = [];
  for (const candidate of sorted) {
    if (!result.some(existing => distanceMeters(existing.position, candidate.position) <= tolerance)) {
      result.push({
        position: { ...candidate.position },
        source: candidate.source,
        priority: candidate.priority,
      });
    }
  }
  return result;
};

/**
 * Build all useful targets. Consumers may choose immediately or keep the list
 * to compare actual OSRM travel times between equally ranked candidates later.
 */
export const buildParkingAccessCandidates = (
  input: ParkingAccessInput,
): ParkingAccessCandidate[] => {
  const kind = classifyParkingGeometry(input);
  const polygon = validPath(input.polygon);
  const polyline = validPath(input.polyline);
  const boundary = kind === 'area' ? polygon : kind === 'street' ? polyline : [];
  const boundaryClosed = kind === 'area';
  const candidates: ParkingAccessCandidate[] = [];

  if (kind === 'area') {
    const center = parkingPolygonCenter(polygon);
    if (center) candidates.push(makeCandidate(center, 'polygon-center'));
  }

  for (const entrance of input.explicitEntrances ?? []) {
    if (!isFiniteParkingCoordinate(entrance) || kind === 'street') continue;
    // The Overpass context is spatial, not relational. Reject a nearby garage
    // entrance that does not actually touch this parking object.
    if (kind === 'area') {
      const nearest = nearestPointOnPath(entrance, polygon, true);
      if (!nearest || nearest.distance > MAX_AREA_ENTRANCE_BOUNDARY_METERS) continue;
    } else if (
      !isFiniteParkingCoordinate(input.position)
      || distanceMeters(entrance, input.position) > MAX_POINT_ENTRANCE_DISTANCE_METERS
    ) {
      continue;
    }
    candidates.push(makeCandidate(entrance, 'explicit-entrance'));
  }

  // Driveway intersections describe entrances to parking areas. For an
  // on-street segment, a crossing driveway is not a parking entrance; its two
  // endpoints are the only honest start candidates.
  if (kind === 'area' && boundary.length >= 2) {
    const snapTolerance =
      Number.isFinite(input.serviceSnapToleranceMeters) &&
      (input.serviceSnapToleranceMeters as number) >= 0
        ? (input.serviceSnapToleranceMeters as number)
        : DEFAULT_SERVICE_SNAP_METERS;

    for (const rawServiceWay of input.serviceWays ?? []) {
      const serviceWay = validPath(rawServiceWay);
      if (serviceWay.length < 2) continue;
      const relation = relateBoundaryToService(boundary, boundaryClosed, serviceWay);
      if (relation.intersections.length > 0) {
        for (const intersection of relation.intersections) {
          candidates.push(makeCandidate(intersection, 'service-intersection'));
        }
      } else if (
        relation.nearestBoundaryPoint &&
        relation.nearestServicePoint &&
        relation.nearestDistance <= snapTolerance
      ) {
        // The route target belongs on the drivable service way, not on a wall or
        // fence along the parking boundary. The boundary point is used only to
        // validate that this service way is genuinely close enough.
        candidates.push(makeCandidate(relation.nearestServicePoint, 'service-nearest'));
      }
    }
  }

  if (kind === 'street' && polyline.length >= 2) {
    candidates.push(makeCandidate(polyline[0], 'street-endpoint'));
    candidates.push(makeCandidate(polyline[polyline.length - 1], 'street-endpoint'));
  }

  if (kind === 'area' && polygon.length >= 3) {
    const fallbackReference = isFiniteParkingCoordinate(input.reference)
      ? input.reference
      : isFiniteParkingCoordinate(input.position)
        ? input.position
        : polygon[0];
    const nearest = nearestPointOnPath(fallbackReference, polygon, true);
    if (nearest) candidates.push(makeCandidate(nearest.position, 'boundary-fallback'));
  }

  if (kind === 'point' && isFiniteParkingCoordinate(input.position)) {
    candidates.push(makeCandidate(input.position, 'parking-position'));
  }

  return dedupeParkingAccessCandidates(
    candidates,
    input.dedupeToleranceMeters,
    input.reference,
  );
};

/** Pick by semantic priority first, then by straight-line proximity. */
export const chooseBestParkingAccessCandidate = (
  candidates: readonly ParkingAccessCandidate[],
  reference?: LatLng | null,
): ParkingAccessCandidate | null => {
  const valid = dedupeParkingAccessCandidates(candidates, 0, reference);
  return valid[0] ?? null;
};

/** Convenient MapScreen entry point for the final navigation destination. */
export const resolveParkingRouteTarget = (
  input: ParkingAccessInput,
): ParkingAccessCandidate | null =>
  chooseBestParkingAccessCandidate(buildParkingAccessCandidates(input), input.reference);
