import { BBox, LatLng, OsmParking } from '../../types/parking';

export const PARKING_CACHE_VERSION = 2 as const;
export const PARKING_CACHE_TTL_MS = 24 * 60 * 60 * 1_000;
export const MAX_MEMORY_PARKINGS = 2_500;
export const MAX_PERSISTED_PARKINGS = 1_500;
export const MAX_COVERAGE_RECTS = 64;
export const MAX_CACHE_JSON_CHARS = 2_000_000;

const MAX_GEOMETRY_POINTS = 10_000;

export interface ParkingCacheEntry {
  parking: OsmParking;
  updatedAt: number;
}

export interface ParkingCoverage {
  bounds: BBox;
  fetchedAt: number;
}

export interface ParkingCacheSnapshot {
  entries: ParkingCacheEntry[];
  coverage: ParkingCoverage[];
}

interface ParkingCacheEnvelope extends ParkingCacheSnapshot {
  version: typeof PARKING_CACHE_VERSION;
  savedAt: number;
}

export interface DecodedParkingCache {
  snapshot: ParkingCacheSnapshot;
  corrupt: boolean;
  needsRewrite: boolean;
}

export interface ValidatedParkingArray {
  items: OsmParking[];
  validContainer: boolean;
  dropped: number;
}

const EMPTY_SNAPSHOT = (): ParkingCacheSnapshot => ({ entries: [], coverage: [] });

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isTimestamp(value: unknown, now: number): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= now + 5 * 60_000;
}

export function isValidLatLng(value: unknown): value is LatLng {
  if (!isRecord(value)) return false;
  const { latitude, longitude } = value;
  return typeof latitude === 'number' && Number.isFinite(latitude) && latitude >= -90 && latitude <= 90
    && typeof longitude === 'number' && Number.isFinite(longitude) && longitude >= -180 && longitude <= 180;
}

function validateGeometry(value: unknown, minimumPoints: number): value is LatLng[] | null {
  return value === null
    || (Array.isArray(value) && value.length >= minimumPoints
      && value.length <= MAX_GEOMETRY_POINTS && value.every(isValidLatLng));
}

export function isValidParking(value: unknown): value is OsmParking {
  if (!isRecord(value)) return false;
  if (typeof value.id !== 'string' || value.id.length === 0 || value.id.length > 80) return false;
  if (!isValidLatLng(value.position)) return false;
  if (!validateGeometry(value.polygon, 3) || !validateGeometry(value.polyline, 2)) return false;
  if (!isRecord(value.tags)) return false;
  return Object.entries(value.tags).every(
    ([key, tag]) => key.length > 0 && key.length <= 200 && typeof tag === 'string' && tag.length <= 2_000,
  );
}

/** Validate an untrusted provider/persistence payload and deduplicate by OSM id. */
export function validateParkingArray(value: unknown): ValidatedParkingArray {
  if (!Array.isArray(value)) return { items: [], validContainer: false, dropped: 0 };

  const byId = new Map<string, OsmParking>();
  let dropped = 0;
  for (const candidate of value) {
    if (!isValidParking(candidate)) {
      dropped += 1;
      continue;
    }
    byId.set(candidate.id, candidate);
  }
  return { items: Array.from(byId.values()), validContainer: true, dropped };
}

export function isValidBBox(value: unknown): value is BBox {
  if (!isRecord(value)) return false;
  const { south, west, north, east } = value;
  return typeof south === 'number' && Number.isFinite(south) && south >= -90
    && typeof north === 'number' && Number.isFinite(north) && north <= 90 && south < north
    && typeof west === 'number' && Number.isFinite(west) && west >= -180
    && typeof east === 'number' && Number.isFinite(east) && east <= 180 && west < east;
}

function isFresh(timestamp: number, now: number, ttlMs: number): boolean {
  return now - timestamp <= ttlMs;
}

/**
 * Decode versioned data. The legacy v1 array has no timestamps and therefore
 * cannot satisfy the freshness contract. It is intentionally invalidated; in
 * particular, object coordinates are never used to manufacture coverage.
 */
export function decodeParkingCache(
  raw: string | null,
  now = Date.now(),
  ttlMs = PARKING_CACHE_TTL_MS,
): DecodedParkingCache {
  if (!raw) return { snapshot: EMPTY_SNAPSHOT(), corrupt: false, needsRewrite: false };

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { snapshot: EMPTY_SNAPSHOT(), corrupt: true, needsRewrite: false };
  }

  if (Array.isArray(parsed)) {
    return {
      snapshot: EMPTY_SNAPSHOT(),
      corrupt: false,
      needsRewrite: true,
    };
  }

  if (!isRecord(parsed) || parsed.version !== PARKING_CACHE_VERSION
      || !isTimestamp(parsed.savedAt, now)
      || !Array.isArray(parsed.entries) || !Array.isArray(parsed.coverage)) {
    return { snapshot: EMPTY_SNAPSHOT(), corrupt: true, needsRewrite: false };
  }

  const entries: ParkingCacheEntry[] = [];
  let dropped = 0;
  for (const candidate of parsed.entries) {
    if (!isRecord(candidate) || !isValidParking(candidate.parking)
        || !isTimestamp(candidate.updatedAt, now) || !isFresh(candidate.updatedAt, now, ttlMs)) {
      dropped += 1;
      continue;
    }
    entries.push({ parking: candidate.parking, updatedAt: candidate.updatedAt });
  }

  const coverage: ParkingCoverage[] = [];
  for (const candidate of parsed.coverage) {
    if (!isRecord(candidate) || !isValidBBox(candidate.bounds)
        || !isTimestamp(candidate.fetchedAt, now) || !isFresh(candidate.fetchedAt, now, ttlMs)) {
      dropped += 1;
      continue;
    }
    coverage.push({ bounds: candidate.bounds, fetchedAt: candidate.fetchedAt });
  }

  const boundedEntries = newestEntries(entries, MAX_PERSISTED_PARKINGS);
  const boundedCoverage = compactCoverage(coverage);
  const bounded = boundedEntries.length !== entries.length || boundedCoverage.length !== coverage.length;
  return {
    snapshot: { entries: boundedEntries, coverage: boundedCoverage },
    corrupt: false,
    needsRewrite: dropped > 0 || bounded,
  };
}

export function newestEntries(entries: ParkingCacheEntry[], limit: number): ParkingCacheEntry[] {
  const unique = new Map<string, ParkingCacheEntry>();
  for (const entry of [...entries].sort((a, b) => b.updatedAt - a.updatedAt)) {
    if (!unique.has(entry.parking.id)) unique.set(entry.parking.id, entry);
  }
  return Array.from(unique.values()).slice(0, limit);
}

/** Keep exact successful rectangles; only exact duplicates are collapsed. */
export function compactCoverage(coverage: ParkingCoverage[]): ParkingCoverage[] {
  const deduped = new Map<string, ParkingCoverage>();
  for (const item of [...coverage].sort((a, b) => b.fetchedAt - a.fetchedAt)) {
    const b = item.bounds;
    const key = `${b.south},${b.west},${b.north},${b.east}`;
    if (!deduped.has(key)) deduped.set(key, item);
  }
  return Array.from(deduped.values()).slice(0, MAX_COVERAGE_RECTS);
}

/** Preserve optional geometry while fresh viewport data updates position/tags. */
export function mergeParking(existing: OsmParking | undefined, incoming: OsmParking): OsmParking {
  if (!existing) return incoming;
  return {
    ...incoming,
    polygon: incoming.polygon ?? existing.polygon,
    polyline: incoming.polyline ?? existing.polyline,
  };
}

function envelopeJson(entries: ParkingCacheEntry[], coverage: ParkingCoverage[], now: number): string {
  const envelope: ParkingCacheEnvelope = {
    version: PARKING_CACHE_VERSION,
    savedAt: now,
    entries,
    coverage,
  };
  return JSON.stringify(envelope);
}

/** Bound both item count and serialized size before touching AsyncStorage. */
export function encodeParkingCache(snapshot: ParkingCacheSnapshot, now = Date.now()): string {
  let entries = newestEntries(snapshot.entries, MAX_PERSISTED_PARKINGS);
  let coverage = compactCoverage(snapshot.coverage);
  if (entries.length < snapshot.entries.length) coverage = [];

  let json = envelopeJson(entries, coverage, now);

  // Geometry is an optional enhancement. Strip the oldest rings first while
  // retaining marker data and therefore the validity of exact coverage.
  for (let i = entries.length - 1; json.length > MAX_CACHE_JSON_CHARS && i >= 0; i -= 1) {
    const entry = entries[i];
    if (entry.parking.polygon || entry.parking.polyline) {
      entries[i] = { ...entry, parking: { ...entry.parking, polygon: null, polyline: null } };
      json = envelopeJson(entries, coverage, now);
    }
  }

  while (json.length > MAX_CACHE_JSON_CHARS && entries.length > 0) {
    entries = entries.slice(0, -1);
    coverage = [];
    json = envelopeJson(entries, coverage, now);
  }

  return json;
}

function bboxArea(bounds: BBox): number {
  return Math.max(0, bounds.east - bounds.west) * Math.max(0, bounds.north - bounds.south);
}

function intersectBBox(a: BBox, b: BBox): BBox | null {
  const south = Math.max(a.south, b.south);
  const west = Math.max(a.west, b.west);
  const north = Math.min(a.north, b.north);
  const east = Math.min(a.east, b.east);
  return south < north && west < east ? { south, west, north, east } : null;
}

/** Exact union coverage, avoiding double-counting overlapping fetched views. */
export function coveredFraction(target: BBox, coverage: ParkingCoverage[]): number {
  const total = bboxArea(target);
  if (total <= 0) return 0;
  const intersections = coverage
    .map((item) => intersectBBox(target, item.bounds))
    .filter((item): item is BBox => item !== null);
  if (intersections.length === 0) return 0;

  const xs = Array.from(new Set(intersections.flatMap((item) => [item.west, item.east])))
    .sort((a, b) => a - b);
  let area = 0;
  for (let i = 0; i < xs.length - 1; i += 1) {
    const left = xs[i];
    const right = xs[i + 1];
    if (right <= left) continue;
    const intervals = intersections
      .filter((item) => item.west < right && item.east > left)
      .map((item) => [item.south, item.north] as const)
      .sort((a, b) => a[0] - b[0]);
    if (intervals.length === 0) continue;

    let coveredY = 0;
    let start = intervals[0][0];
    let end = intervals[0][1];
    for (let j = 1; j < intervals.length; j += 1) {
      const [nextStart, nextEnd] = intervals[j];
      if (nextStart <= end) end = Math.max(end, nextEnd);
      else {
        coveredY += end - start;
        start = nextStart;
        end = nextEnd;
      }
    }
    coveredY += end - start;
    area += (right - left) * coveredY;
  }

  return Math.min(1, area / total);
}

export function isContainedInAny(target: BBox, coverage: ParkingCoverage[]): boolean {
  return coverage.some(({ bounds }) => target.south >= bounds.south && target.west >= bounds.west
    && target.north <= bounds.north && target.east <= bounds.east);
}
