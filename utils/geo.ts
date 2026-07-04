import { LatLng, BBox } from '../types/parking';

const R = 6_371_000; // радиус Земли в метрах

/**
 * Приблизительный zoom-уровень из latitudeDelta.
 *   zoom 12 → delta ≈ 0.088
 *   zoom 13 → delta ≈ 0.044
 *   zoom 14 → delta ≈ 0.022
 *   zoom 15 → delta ≈ 0.011
 */
export const deltaToZoom = (latitudeDelta: number): number =>
  Math.round(Math.log2(360 / latitudeDelta));

/** Расстояние между двумя координатами в метрах (формула Haversine). */
export const haversineDistance = (a: LatLng, b: LatLng): number => {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b.latitude  - a.latitude);
  const dLon = toRad(b.longitude - a.longitude);
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const chord =
    sinLat * sinLat +
    Math.cos(toRad(a.latitude)) * Math.cos(toRad(b.latitude)) * sinLon * sinLon;
  return R * 2 * Math.atan2(Math.sqrt(chord), Math.sqrt(1 - chord));
};

/**
 * Approximate radius (in meters) of the visible map viewport — the distance
 * from its center to a corner (half the diagonal). Used to decide whether the
 * camera is zoomed in enough to render park-area polygons and markers.
 */
export const viewportRadiusMeters = (bbox: BBox): number => {
  const center: LatLng = {
    latitude:  (bbox.north + bbox.south) / 2,
    longitude: (bbox.east  + bbox.west)  / 2,
  };
  return haversineDistance(center, { latitude: bbox.north, longitude: bbox.east });
};

/**
 * The longest single edge of a ring, as a 2-point segment.
 *
 * Park-area polygons are mostly long, narrow bays hugging a road — tracing
 * their full rectangular outline reads as a "box" rather than a parking
 * stripe. Their longest edge runs along the road and alone approximates the
 * bay's orientation and extent, giving a simple preview *line* instead.
 */
export const longestEdge = (coords: LatLng[]): [LatLng, LatLng] | null => {
  if (coords.length < 2) return null;
  let best: [LatLng, LatLng] | null = null;
  let bestLen = -Infinity;
  for (let i = 0; i < coords.length - 1; i++) {
    const len = haversineDistance(coords[i], coords[i + 1]);
    if (len > bestLen) { bestLen = len; best = [coords[i], coords[i + 1]]; }
  }
  return best;
};

// ─── Polygon simplification (Ramer-Douglas-Peucker) ─────────────────────────

/**
 * Перпендикулярное расстояние точки от хорды (в метрах).
 * Используется внутри алгоритма RDP.
 */
function perpDistance(p: LatLng, a: LatLng, b: LatLng): number {
  const dx = b.longitude - a.longitude;
  const dy = b.latitude  - a.latitude;
  const mag = Math.sqrt(dx * dx + dy * dy);
  if (mag < 1e-10) return haversineDistance(p, a);
  const u = ((p.longitude - a.longitude) * dx + (p.latitude - a.latitude) * dy) / (mag * mag);
  const foot: LatLng = { latitude: a.latitude + u * dy, longitude: a.longitude + u * dx };
  return haversineDistance(p, foot);
}

function rdp(pts: LatLng[], tol: number): LatLng[] {
  if (pts.length < 3) return pts;
  let maxD = 0, idx = 0;
  const last = pts.length - 1;
  for (let i = 1; i < last; i++) {
    const d = perpDistance(pts[i], pts[0], pts[last]);
    if (d > maxD) { maxD = d; idx = i; }
  }
  if (maxD > tol) {
    const left  = rdp(pts.slice(0, idx + 1), tol);
    const right = rdp(pts.slice(idx), tol);
    return [...left.slice(0, -1), ...right];
  }
  return [pts[0], pts[last]];
}

/**
 * Упрощает полигон/полилинию алгоритмом Рамера-Дугласа-Пекера.
 * Удаляет точки, отклонение которых от хорды < toleranceMeters.
 * Ускоряет рендеринг сложных контуров OSM (50-200 вершин → 10-20).
 */
export const simplifyCoords = (coords: LatLng[], toleranceMeters = 2): LatLng[] => {
  if (coords.length <= 4) return coords;
  const simplified = rdp(coords, toleranceMeters);
  // Для замкнутых полигонов сохраняем замкнутость
  const first = coords[0], last = coords[coords.length - 1];
  const wasClosed =
    Math.abs(first.latitude  - last.latitude)  < 1e-7 &&
    Math.abs(first.longitude - last.longitude) < 1e-7;
  if (wasClosed && simplified.length >= 2) {
    const sf = simplified[0], sl = simplified[simplified.length - 1];
    const isClosed =
      Math.abs(sf.latitude  - sl.latitude)  < 1e-7 &&
      Math.abs(sf.longitude - sl.longitude) < 1e-7;
    if (!isClosed) simplified.push(simplified[0]);
  }
  return simplified;
};

// ─── Formatting ───────────────────────────────────────────────────────────────

export const formatDistance = (km: number): string =>
  km < 1 ? `${Math.round(km * 1000)} m` : `${km.toFixed(1)} km`;

export const formatDuration = (minutes: number): string => {
  if (minutes < 60) return `${Math.round(minutes)} min`;
  const h = Math.floor(minutes / 60);
  const m = Math.round(minutes % 60);
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
};
