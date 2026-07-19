/**
 * overpassService.ts
 *
 * Загружает парковки из OpenStreetMap через Overpass API.
 *
 * ── Двухуровневая загрузка геометрии ────────────────────────────────────────
 *
 * Полный контур (`out geom`) каждой зоны раздувает payload bulk-запроса в
 * разы и было основной причиной долгой загрузки — поэтому он больше НЕ
 * запрашивается за один раз для всего вьюпорта:
 *
 *   1. buildOverpassQuery — лёгкий `out center`: только координаты + теги.
 *      Этого достаточно для маркеров/кластеров и держит первую отрисовку
 *      быстрой даже над широкими областями.
 *   2. fetchParkingGeometryBatch — точный `out geom`, но ТОЛЬКО для зон,
 *      реально видимых при близком зуме (useMapParkings.loadZoneGeometry
 *      собирает их id и шлёт один комбинированный запрос вместо N лазерных).
 *
 * out center → для way/relation: center: {lat, lon}      — центр (иконка)
 * out geom   → для way/relation: geometry: [{lat, lon}…] — контур (Polygon/Polyline)
 *
 * ── Парсинг геометрии OSM ───────────────────────────────────────────────────
 *
 *   node      → lat/lon напрямую; polygon = null
 *   way       → el.geometry[] даёт контур
 *               замкнутый (first == last) → Polygon (parking area)
 *               незамкнутый               → Polyline (street_side / lane)
 *   relation  → берём первый outer-контур из members
 */

import { LatLng, OsmParking } from '../types/parking';
import { isRestrictedParking } from '../utils/parking';

// ─── Mirror pools ─────────────────────────────────────────────────────────────
//
// Bulk viewport queries (fetchParkingData) and lightweight geometry queries
// (fetchParkingGeometry / fetchParkingGeometryBatch) use SEPARATE mirror pools
// (separate blacklists/cooldowns) so one query type can't poison the other —
// a heavy bulk query timing out on a loaded mirror doesn't exile it from fast
// single-element geometry lookups too.
//
// Both pools race every non-blacklisted mirror IN PARALLEL (fetchParallel)
// rather than trying them one at a time: real-world testing showed 2-4 of the
// 6 mirrors failing simultaneously is common, and a sequential try-in-order
// meant the user waited through every dead mirror's own timeout before ever
// reaching a live one (worst case: N × timeout, stacked). Racing them means
// only the FASTEST response matters — a dead mirror's failure latency no
// longer adds to the total wait at all.

// `maps.mail.ru` verified against a real Málaga query (returns actual parking
// data, not just HTTP 200) — kept first since the other 5 have repeatedly
// shown simultaneous failures in testing. If adding a new candidate, verify
// it the same way: `?data=[out:json];node["amenity"="parking"](36.7196,-4.4232,36.7315,-4.4142);out;`
// — an earlier candidate (overpass.osm.ch) responded fine but turned out to
// be a Switzerland-only regional mirror that silently returns zero results
// for Spain, which is worse than a mirror that's simply offline.
const OVERPASS_MIRRORS = [
  'https://maps.mail.ru/osm/tools/overpass/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

// ── Bulk pool (viewport queries) ──────────────────────────────────────────────
const BULK_PER_MIRROR_MS        = 6_000;
const BULK_BLACKLIST_MS         = 5 * 60_000;
// Cooldown after every mirror fails at once — stops a user mashing "Search
// this area" from re-racing 6 already-just-failed servers on every tap.
const BULK_ALL_FAIL_COOLDOWN_MS = 15_000;
const bulkFailed                = new Map<string, number>();
let   bulkFastest: string | null = null;
let   bulkFastestMs              = Infinity;
let   bulkAllFailedUntil         = 0;

// ── Geo pool (single-element / batched geometry) ──────────────────────────────
// `out geom` for a batch of parking ways returns full polygon rings and is much
// heavier than the `out center` bulk query — it legitimately needs longer than
// the old 5 s (which timed out even on the mirror that answers bulk in <1 s).
const GEO_PER_MIRROR_MS   = 12_000;
const GEO_BLACKLIST_MS    = 10_000; // re-admit mirrors quickly — brief instability shouldn't lock for long
// Geometry is a best-effort enhancement (zone outlines); when the whole geo
// network is unreachable, back off for a while instead of retrying every search.
const GEO_ALL_FAIL_COOLDOWN_MS = 45_000;
const geoFailed           = new Map<string, number>();
let   geoFastest: string | null = null;
let   geoFastestMs               = Infinity;
let   geoAllFailedUntil          = 0;        // global cooldown after total blackout

// ── Shared fetch helper ───────────────────────────────────────────────────────

interface Pool {
  failed:            Map<string, number>;
  fastest:           string | null;
  fastestMs:         number;
  perMirrorMs:       number;
  blacklistMs:       number;
  allFailedUntil:    number;
  allFailCooldownMs: number;
  setFastest:        (url: string, ms: number) => void;
  addFailed:         (url: string, until: number) => void;
  setAllFailedUntil: (until: number) => void;
}

const BULK_POOL: Pool = {
  failed:      bulkFailed,
  get fastest()   { return bulkFastest;   },
  get fastestMs() { return bulkFastestMs; },
  perMirrorMs: BULK_PER_MIRROR_MS,
  blacklistMs: BULK_BLACKLIST_MS,
  get allFailedUntil() { return bulkAllFailedUntil; },
  allFailCooldownMs: BULK_ALL_FAIL_COOLDOWN_MS,
  setFastest:  (url, ms) => { bulkFastest = url; bulkFastestMs = ms; },
  addFailed:   (url, until) => bulkFailed.set(url, until),
  setAllFailedUntil: (until) => { bulkAllFailedUntil = until; },
};

const GEO_POOL: Pool = {
  failed:      geoFailed,
  get fastest()   { return geoFastest;   },
  get fastestMs() { return geoFastestMs; },
  perMirrorMs: GEO_PER_MIRROR_MS,
  blacklistMs: GEO_BLACKLIST_MS,
  get allFailedUntil() { return geoAllFailedUntil; },
  allFailCooldownMs: GEO_ALL_FAIL_COOLDOWN_MS,
  setFastest:  (url, ms) => { geoFastest = url; geoFastestMs = ms; },
  addFailed:   (url, until) => geoFailed.set(url, until),
  setAllFailedUntil: (until) => { geoAllFailedUntil = until; },
};

// ── Parallel fetch — races every healthy mirror simultaneously ───────────────
// Only the fastest SUCCESSFUL response matters; a dead/slow mirror's own
// timeout never adds to the total wait. Worst case (every mirror down) is one
// perMirrorMs timeout, not N of them stacked sequentially.
async function fetchParallel(
  query:       string,
  pool:        Pool,
  poolLabel:   string,
  userSignal?: AbortSignal,
): Promise<unknown> {
  const now = Date.now();

  if (now < pool.allFailedUntil) {
    throw new Error(
      `All Overpass mirrors on cooldown — retry in ${Math.ceil((pool.allFailedUntil - now) / 1000)} s`,
    );
  }

  let candidates = OVERPASS_MIRRORS.filter(url => (pool.failed.get(url) ?? 0) <= now);
  if (candidates.length === 0) {
    console.warn(`[overpassService] all ${poolLabel} mirrors blacklisted — resetting`);
    pool.failed.clear();
    candidates = [...OVERPASS_MIRRORS];
  }

  const fastest = pool.fastest;
  if (fastest && candidates.includes(fastest) && candidates[0] !== fastest) {
    candidates = [fastest, ...candidates.filter(u => u !== fastest)];
  }

  // One AbortController per mirror so the winner can cancel the rest.
  const ctrls = candidates.map(() => new AbortController());
  const cancelAll = () => ctrls.forEach(c => c.abort());
  userSignal?.addEventListener('abort', cancelAll, { once: true });

  const errors: string[] = [];

  const attempts = candidates.map((url, i) => {
    const ctrl = ctrls[i];
    const host = url.split('/')[2];
    const t0   = Date.now();

    const timer = setTimeout(() => {
      pool.addFailed(url, now + pool.blacklistMs);
      errors.push(`${host}:timeout`);
      console.warn(`[overpassService] ${host} → timeout — blacklisted`);
      ctrl.abort();
    }, pool.perMirrorMs);

    return fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal })
      .then(async res => {
        clearTimeout(timer);
        if (!res.ok) {
          if (res.status === 504 || res.status === 429 || res.status === 503) {
            pool.addFailed(url, now + pool.blacklistMs);
            console.warn(`[overpassService] ${host} → HTTP ${res.status} — blacklisted`);
          }
          errors.push(`${host}:${res.status}`);
          throw new Error(`Overpass HTTP ${res.status}`);
        }
        const json    = await res.json();
        const elapsed = Date.now() - t0;
        if (elapsed < pool.fastestMs) pool.setFastest(url, elapsed);
        console.log(`[overpassService] ${host} OK in ${elapsed} ms`);
        return json;
      })
      .catch(err => {
        clearTimeout(timer);
        // An AbortError here means either this mirror's own timeout already
        // handled it above, OR it was cancelled because a sibling won the
        // race / the caller superseded the request — neither is a genuine
        // failure of THIS mirror, so don't blacklist or report it twice.
        if (!(err instanceof Error && err.name === 'AbortError')) {
          pool.addFailed(url, now + pool.blacklistMs);
          errors.push(`${host}:err`);
          console.warn(`[overpassService] ${host} →`, err);
        }
        throw err;
      });
  });

  try {
    const result = await Promise.any(attempts);
    cancelAll();
    userSignal?.removeEventListener('abort', cancelAll);
    return result;
  } catch {
    userSignal?.removeEventListener('abort', cancelAll);
    if (userSignal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
    pool.setAllFailedUntil(now + pool.allFailCooldownMs);
    throw new Error(`All Overpass mirrors failed [${errors.join(' | ')}]`);
  }
}

// ─── Запрос ───────────────────────────────────────────────────────────────────

export function buildOverpassQuery(
  south: number, west: number, north: number, east: number,
): string {
  const bbox = `${south},${west},${north},${east}`;
  // Lightweight bulk fetch — `out center` returns positions + tags only, so
  // the viewport query stays fast and small even over wide areas. Full ring
  // geometry for the handful of zones actually visible at close zoom is
  // fetched separately and on demand — see fetchParkingGeometryBatch below.
  return `[out:json][timeout:10][maxsize:2000000];
(
  node["amenity"="parking"](${bbox});
  way["amenity"="parking"](${bbox});
  relation["amenity"="parking"](${bbox});
  way["parking"="street_side"](${bbox});
  way["parking"="lane"](${bbox});
  node["parking"="street_side"](${bbox});
  node["parking"="lane"](${bbox});
  way["highway"]["parking:left"~"^(yes|lane|street_side|on_kerb|half_on_kerb|shoulder)$"](${bbox});
  way["highway"]["parking:right"~"^(yes|lane|street_side|on_kerb|half_on_kerb|shoulder)$"](${bbox});
  way["highway"]["parking:both"~"^(yes|lane|street_side|on_kerb|half_on_kerb|shoulder)$"](${bbox});
);
out center;`;
}

// ─── HTTP запрос ──────────────────────────────────────────────────────────────

export async function fetchParkingData(
  south: number, west: number, north: number, east: number,
  signal?: AbortSignal,
): Promise<OsmParking[]> {
  const query = buildOverpassQuery(south, west, north, east);
  const json  = await fetchParallel(query, BULK_POOL, 'bulk', signal);
  return parseOverpassData(json);
}

// ─── Парсинг ответа Overpass ──────────────────────────────────────────────────

export function isOverpassEnvelope(json: unknown): json is { elements: unknown[] } {
  return typeof json === 'object' && json !== null
    && Array.isArray((json as { elements?: unknown }).elements);
}

export function parseOverpassData(json: unknown): OsmParking[] {
  if (!isOverpassEnvelope(json)) return [];
  const byId = new Map<string, OsmParking>();
  json.elements
    .map(parseElement)
    .filter((p): p is OsmParking => p !== null)
    .forEach((parking) => byId.set(parking.id, parking));
  return Array.from(byId.values());
}

function parseTags(value: unknown): Record<string, string> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

const STREET_PARKING_VALUES = new Set([
  'yes', 'lane', 'street_side', 'on_kerb', 'half_on_kerb', 'shoulder',
]);

function normaliseStreetParkingTags(raw: Record<string, string>): Record<string, string> {
  if (!raw.highway) return raw;
  const sides = (['both', 'left', 'right'] as const)
    .filter((side) => STREET_PARKING_VALUES.has(raw[`parking:${side}`]));
  if (sides.length === 0) return raw;

  const tags: Record<string, string> = {
    ...raw,
    __parking_sides: sides.join(','),
    __parking_geometry: 'street',
  };
  const values = sides.map((side) => raw[`parking:${side}`]).filter(Boolean);
  if (values.length > 0) tags.parking = values.every((value) => value === values[0])
    ? values[0]
    : 'street';

  for (const field of ['fee', 'access', 'maxstay'] as const) {
    const sideValues = sides.map((side) => raw[`parking:${side}:${field}`]).filter(Boolean);
    if (sideValues.length === sides.length && sideValues.every((value) => value === sideValues[0])) {
      tags[field] = sideValues[0];
    }
  }
  return tags;
}

function parseElement(el: unknown): OsmParking | null {
  if (typeof el !== 'object' || el === null || Array.isArray(el)) return null;
  const element = el as Record<string, any>;
  const rawId = element.id;
  if (!((typeof rawId === 'number' && Number.isSafeInteger(rawId) && rawId > 0)
      || (typeof rawId === 'string' && /^\d+$/.test(rawId) && rawId !== '0'))) return null;
  const tags = normaliseStreetParkingTags(parseTags(element.tags));
  if (isRestrictedParking(tags)) return null;

  // ── node: только точка, геометрии нет ─────────────────────────────────────
  if (element.type === 'node') {
    const position = parseOsmCoordinate({ lat: element.lat, lon: element.lon });
    if (!position) return null;
    return {
      id:       `n${rawId}`,
      position,
      polygon:  null,
      polyline: null,
      tags,
    };
  }

  // ── way: контур через el.geometry ─────────────────────────────────────────
  if (element.type === 'way') {
    const coords = osmGeoToCoords(element.geometry ?? []);

    // el.center — предвычисленный центр, быстрее чем считать самому
    const position = element.center
      ? parseOsmCoordinate(element.center)
      : computeCenter(coords);
    if (!position || !isAccessCoordinate(position) || (coords.length === 0 && !element.center)) return null;

    // Замкнутый way (первая точка == последняя) → parking area → Polygon
    // Незамкнутый → parking lane / street_side → Polyline
    const closed = isClosed(coords);
    return {
      id:       `w${rawId}`,
      position,
      polygon:  closed && coords.length >= 3 ? coords : null,
      polyline: !closed && coords.length >= 2 ? coords : null,
      tags,
    };
  }

  // ── relation: берём outer-контур мультиполигона ───────────────────────────
  if (element.type === 'relation') {
    const coords = relationOuterRing(element.members);
    const position = element.center
      ? parseOsmCoordinate(element.center)
      : computeCenter(coords);
    if (!position || !isAccessCoordinate(position) || (coords.length === 0 && !element.center)) return null;
    return {
      id:       `r${rawId}`,
      position,
      polygon:  coords.length >= 4 ? coords : null,
      polyline: null,
      tags,
    };
  }

  return null;
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────

function osmGeoToCoords(geo: unknown): LatLng[] {
  if (!Array.isArray(geo)) return [];
  return geo.map(parseOsmCoordinate).filter((point): point is LatLng => point !== null);
}

/** Замкнутый контур: первая и последняя точки совпадают (с допуском). */
function isClosed(coords: LatLng[]): boolean {
  if (coords.length < 2) return false;
  const a = coords[0], z = coords[coords.length - 1];
  return Math.abs(a.latitude - z.latitude) < 1e-7 &&
         Math.abs(a.longitude - z.longitude) < 1e-7;
}

export function computeCenter(coords: LatLng[]): LatLng {
  if (!coords.length) return { latitude: 0, longitude: 0 };
  const n = coords.length;
  return coords.reduce(
    (acc, c) => ({
      latitude:  acc.latitude  + c.latitude  / n,
      longitude: acc.longitude + c.longitude / n,
    }),
    { latitude: 0, longitude: 0 },
  );
}

function sameCoordinate(a: LatLng, b: LatLng): boolean {
  return Math.abs(a.latitude - b.latitude) < 1e-7 &&
         Math.abs(a.longitude - b.longitude) < 1e-7;
}

function approximateRingArea(coords: LatLng[]): number {
  let twiceArea = 0;
  for (let index = 0; index < coords.length - 1; index += 1) {
    twiceArea += coords[index].longitude * coords[index + 1].latitude -
      coords[index + 1].longitude * coords[index].latitude;
  }
  return Math.abs(twiceArea) / 2;
}

/** Stitch split OSM relation members and return the largest valid outer ring. */
function relationOuterRing(members: unknown): LatLng[] {
  if (!Array.isArray(members)) return [];
  const fragments = members
    .filter(member => member && typeof member === 'object' &&
      (member as any).type === 'way' && (member as any).role === 'outer')
    .map(member => osmGeoToCoords((member as any).geometry ?? []))
    .filter(fragment => fragment.length >= 2);
  const rings: LatLng[][] = [];

  while (fragments.length > 0) {
    let chain = fragments.shift()!;
    let joined = true;
    while (!isClosed(chain) && joined) {
      joined = false;
      const start = chain[0];
      const end = chain[chain.length - 1];
      for (let index = 0; index < fragments.length; index += 1) {
        const fragment = fragments[index];
        const fragmentStart = fragment[0];
        const fragmentEnd = fragment[fragment.length - 1];
        if (sameCoordinate(end, fragmentStart)) {
          chain = [...chain, ...fragment.slice(1)];
        } else if (sameCoordinate(end, fragmentEnd)) {
          chain = [...chain, ...fragment.slice().reverse().slice(1)];
        } else if (sameCoordinate(start, fragmentEnd)) {
          chain = [...fragment.slice(0, -1), ...chain];
        } else if (sameCoordinate(start, fragmentStart)) {
          chain = [...fragment.slice().reverse().slice(0, -1), ...chain];
        } else {
          continue;
        }
        fragments.splice(index, 1);
        joined = true;
        break;
      }
    }
    if (chain.length >= 4 && isClosed(chain)) rings.push(chain);
  }

  return rings.sort((a, b) => approximateRingArea(b) - approximateRingArea(a))[0] ?? [];
}

// ─── Selected parking access context ─────────────────────────────────────────
// This deliberately stays out of the viewport query. Access roads can contain
// a lot of geometry, while they are only useful after the user selects one
// parking zone and asks the app to choose a sensible route destination.

export interface ParkingAccessContext {
  entrances: LatLng[];
  serviceWays: LatLng[][];
}

const ACCESS_MIN_RADIUS_METERS = 50;
const ACCESS_MAX_RADIUS_METERS = 250;
const ACCESS_GEOMETRY_MARGIN_METERS = 40;
const ACCESS_MAX_ENTRANCES = 64;
const ACCESS_MAX_SERVICE_WAYS = 128;
const ACCESS_MAX_POINTS_PER_WAY = 2_048;
const EARTH_RADIUS_METERS = 6_371_000;

function isAccessCoordinate(value: unknown): value is LatLng {
  if (!value || typeof value !== 'object') return false;
  const point = value as Partial<LatLng>;
  return typeof point.latitude === 'number'
    && Number.isFinite(point.latitude)
    && point.latitude >= -90
    && point.latitude <= 90
    && typeof point.longitude === 'number'
    && Number.isFinite(point.longitude)
    && point.longitude >= -180
    && point.longitude <= 180;
}

function parseOsmCoordinate(value: unknown): LatLng | null {
  if (!value || typeof value !== 'object') return null;
  const point = value as { lat?: unknown; lon?: unknown };
  const coordinate = { latitude: point.lat, longitude: point.lon };
  return isAccessCoordinate(coordinate) ? coordinate : null;
}

function accessCoordinateKey(point: LatLng): string {
  // Six decimal places are precise to roughly 0.1 m at Malaga's latitude and
  // collapse duplicate Overpass elements without merging distinct entrances.
  return `${point.latitude.toFixed(6)},${point.longitude.toFixed(6)}`;
}

function distanceMeters(a: LatLng, b: LatLng): number {
  const toRadians = (degrees: number) => degrees * Math.PI / 180;
  const dLat = toRadians(b.latitude - a.latitude);
  const dLon = toRadians(b.longitude - a.longitude);
  const lat1 = toRadians(a.latitude);
  const lat2 = toRadians(b.latitude);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_METERS * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Search radius for a single selected parking, including a small road margin. */
export function calculateParkingAccessRadius(parking: OsmParking): number {
  const center = parking?.position;
  if (!isAccessCoordinate(center)) return ACCESS_MIN_RADIUS_METERS;

  const geometry = parking.polygon ?? parking.polyline ?? [];
  let extent = 0;
  for (const point of geometry) {
    if (isAccessCoordinate(point)) {
      extent = Math.max(extent, distanceMeters(center, point));
    }
  }

  return Math.max(
    ACCESS_MIN_RADIUS_METERS,
    Math.min(ACCESS_MAX_RADIUS_METERS, Math.ceil(extent + ACCESS_GEOMETRY_MARGIN_METERS)),
  );
}

/** A bounded Overpass query used only for the parking currently selected. */
export function buildParkingAccessQuery(parking: OsmParking): string {
  if (!isAccessCoordinate(parking?.position)) {
    throw new Error('Cannot load parking access context: invalid parking position');
  }

  const { latitude, longitude } = parking.position;
  const radius = calculateParkingAccessRadius(parking);
  const around = `(around:${radius},${latitude},${longitude})`;

  return `[out:json][timeout:10][maxsize:500000];
(
  node["amenity"="parking_entrance"]["access"!~"^(no|private)$"]["vehicle"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]${around};
  way["highway"="service"]["access"!~"^(no|private)$"]["vehicle"!~"^(no|private)$"]["motor_vehicle"!~"^(no|private)$"]${around};
);
out geom qt;`;
}

function isDrivableServiceWay(tags: unknown): boolean {
  if (!tags || typeof tags !== 'object') return false;
  const values = tags as Record<string, unknown>;
  if (values.highway !== 'service') return false;

  const access = values.access;
  const vehicle = values.vehicle;
  const motorVehicle = values.motor_vehicle;
  return access !== 'no'
    && access !== 'private'
    && vehicle !== 'no'
    && vehicle !== 'private'
    && motorVehicle !== 'no'
    && motorVehicle !== 'private';
}

function isDrivableParkingEntrance(tags: unknown): boolean {
  if (!tags || typeof tags !== 'object') return false;
  const values = tags as Record<string, unknown>;
  if (values.amenity !== 'parking_entrance') return false;
  return values.access !== 'no'
    && values.access !== 'private'
    && values.vehicle !== 'no'
    && values.vehicle !== 'private'
    && values.motor_vehicle !== 'no'
    && values.motor_vehicle !== 'private';
}

function dedupeConsecutiveCoordinates(points: LatLng[]): LatLng[] {
  const result: LatLng[] = [];
  let previousKey: string | null = null;
  for (const point of points) {
    const key = accessCoordinateKey(point);
    if (key !== previousKey) result.push(point);
    previousKey = key;
  }
  return result;
}

function serviceWayKey(points: LatLng[]): string {
  const forward = points.map(accessCoordinateKey).join(';');
  const reverse = [...points].reverse().map(accessCoordinateKey).join(';');
  return forward < reverse ? forward : reverse;
}

/** Runtime-safe parser for the selected-parking access query. */
export function parseParkingAccessContext(payload: unknown): ParkingAccessContext {
  const empty: ParkingAccessContext = { entrances: [], serviceWays: [] };
  if (!payload || typeof payload !== 'object') return empty;

  const elements = (payload as { elements?: unknown }).elements;
  if (!Array.isArray(elements)) return empty;

  const entrances: LatLng[] = [];
  const serviceWays: LatLng[][] = [];
  const entranceKeys = new Set<string>();
  const serviceWayKeys = new Set<string>();

  for (const rawElement of elements) {
    if (!rawElement || typeof rawElement !== 'object') continue;
    const element = rawElement as {
      type?: unknown;
      lat?: unknown;
      lon?: unknown;
      tags?: unknown;
      geometry?: unknown;
    };

    if (element.type === 'node') {
      if (!isDrivableParkingEntrance(element.tags)) continue;
      const point = parseOsmCoordinate(element);
      if (!point) continue;
      const key = accessCoordinateKey(point);
      if (!entranceKeys.has(key) && entrances.length < ACCESS_MAX_ENTRANCES) {
        entranceKeys.add(key);
        entrances.push(point);
      }
      continue;
    }

    if (element.type !== 'way' || !isDrivableServiceWay(element.tags)) continue;
    if (!Array.isArray(element.geometry)) continue;

    const parsedPoints = element.geometry
      .slice(0, ACCESS_MAX_POINTS_PER_WAY)
      .map(parseOsmCoordinate)
      .filter((point): point is LatLng => point !== null);
    const points = dedupeConsecutiveCoordinates(parsedPoints);
    if (points.length < 2) continue;

    const key = serviceWayKey(points);
    if (!serviceWayKeys.has(key) && serviceWays.length < ACCESS_MAX_SERVICE_WAYS) {
      serviceWayKeys.add(key);
      serviceWays.push(points);
    }
  }

  return { entrances, serviceWays };
}

export async function fetchParkingAccessContext(
  parking: OsmParking,
  signal?: AbortSignal,
): Promise<ParkingAccessContext> {
  const query = buildParkingAccessQuery(parking);
  const payload = await fetchParallel(query, GEO_POOL, 'geo', signal);
  return parseParkingAccessContext(payload);
}

// ─── Lazy geometry fetch ──────────────────────────────────────────────────────
// Called only when the user taps a marker. Fetches the full ring for one OSM
// element — way or relation — using a targeted `out geom` query.
// Nodes (prefix "n") are single points and have no ring to fetch.

export type GeometryResult = {
  polygon:  LatLng[] | null;
  polyline: LatLng[] | null;
};

export async function fetchParkingGeometry(
  osmId:   string,          // "w123456" | "r123456" | "n123456"
  signal?: AbortSignal,
): Promise<GeometryResult> {
  const prefix = osmId[0];
  const numId  = osmId.slice(1);

  if (prefix === 'n') return { polygon: null, polyline: null };

  const type = prefix === 'w' ? 'way' : 'relation';
  // [timeout:15] — server-side budget; single-element queries normally finish
  // in < 1 s on a healthy mirror, so 15 s is generous but safe for slow ones.
  const query = `[out:json][timeout:15]; ${type}(${numId}); out geom;`;

  const json = await fetchParallel(query, GEO_POOL, 'geo', signal);
  const el   = ((json as { elements: unknown[] }).elements as any[])[0];
  if (!el) return { polygon: null, polyline: null };

  if (type === 'way') {
    const coords = osmGeoToCoords(el.geometry ?? []);
    const closed = isClosed(coords);
    return {
      polygon:  closed && coords.length >= 3 ? coords : null,
      polyline: !closed && coords.length >= 2 ? coords : null,
    };
  }

  // relation: take the first outer member ring
  const coords = relationOuterRing(el.members);
  return {
    polygon:  coords.length >= 4 ? coords : null,
    polyline: null,
  };
}

// ─── Batched geometry fetch (zones visible at close zoom) ────────────────────
// Bridges the gap left by the now-lightweight bulk query: once the camera is
// close enough to show precise zone outlines, useMapParkings collects the ids
// of the on-screen elements still missing geometry and fetches all of their
// rings in ONE combined request — far cheaper than `out geom` over the whole
// viewport, and far cheaper than fetchParkingGeometry called once per zone.
// Nodes are excluded by the caller (single points — nothing to fetch).

export async function fetchParkingGeometryBatch(
  osmIds:  string[],        // e.g. ["w123456", "r987654", …] — no "n…" entries
  signal?: AbortSignal,
): Promise<Map<string, GeometryResult>> {
  const result = new Map<string, GeometryResult>();

  const wayIds      = osmIds.filter(id => id[0] === 'w').map(id => id.slice(1));
  const relationIds = osmIds.filter(id => id[0] === 'r').map(id => id.slice(1));
  if (wayIds.length === 0 && relationIds.length === 0) return result;

  const parts: string[] = [];
  if (wayIds.length)      parts.push(`way(id:${wayIds.join(',')});`);
  if (relationIds.length) parts.push(`relation(id:${relationIds.join(',')});`);

  // [timeout:20] — a batch covers a small, close-zoom viewport (a few dozen
  // elements at most), so this still finishes well within the budget.
  const query = `[out:json][timeout:20][maxsize:1000000];(${parts.join('')});out geom;`;
  const json  = await fetchParallel(query, GEO_POOL, 'geo', signal);

  for (const el of ((json as { elements: unknown[] }).elements as any[])) {
    if (el.type === 'way') {
      const coords = osmGeoToCoords(el.geometry ?? []);
      const closed = isClosed(coords);
      result.set(`w${el.id}`, {
        polygon:  closed && coords.length >= 3 ? coords : null,
        polyline: !closed && coords.length >= 2 ? coords : null,
      });
    } else if (el.type === 'relation') {
      const coords = relationOuterRing(el.members);
      result.set(`r${el.id}`, {
        polygon:  coords.length >= 4 ? coords : null,
        polyline: null,
      });
    }
  }

  return result;
}
