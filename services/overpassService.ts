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

// ─── Mirror pools ─────────────────────────────────────────────────────────────
//
// Bulk viewport queries (fetchParkingData) and lightweight geometry queries
// (fetchParkingGeometry / fetchParkingGeometryBatch) use SEPARATE mirror pools.
//
// Why this matters: a heavy viewport query legitimately takes 3–6 s on a loaded
// mirror, so a 6 s per-mirror timeout + 5-minute blacklist is correct for bulk.
// But single-element geometry queries normally complete in 300–400 ms. When the
// SAME blacklist state was shared, one bulk timeout would exile a mirror for 5
// minutes — and all subsequent geometry requests would skip that mirror too,
// cascading until ALL mirrors were blacklisted and the user's tap opened an
// empty bottom sheet. Now the two query types can't poison each other.
//
// GEO pool extras:
//   • 3.5 s per-mirror timeout (vs 6 s for bulk) — geometry is fast; fail sooner
//   • 30 s blacklist (vs 5 min) — brief instability shouldn't lock the user out
//   • Global 10 s cooldown after all-mirrors-fail — prevents the reset→retry→
//     fail loop from hammering mirrors when the whole Overpass network is down

const OVERPASS_MIRRORS = [
  'https://overpass.kumi.systems/api/interpreter',   // CloudFlare CDN — most reliable from EU/ES
  'https://overpass-api.de/api/interpreter',
  'https://overpass.openstreetmap.ru/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

// ── Bulk pool (viewport queries) ──────────────────────────────────────────────
const BULK_PER_MIRROR_MS  = 6_000;
const BULK_BLACKLIST_MS   = 5 * 60_000;
const bulkFailed          = new Map<string, number>();
let   bulkFastest: string | null = null;
let   bulkFastestMs              = Infinity;

// ── Geo pool (single-element / batched geometry) ──────────────────────────────
const GEO_PER_MIRROR_MS   = 5_000;  // geometry queries are simple; 5 s is generous but avoids 8 s ANR
const GEO_BLACKLIST_MS    = 10_000; // re-admit mirrors quickly — brief instability shouldn't lock for long
const GEO_ALL_FAIL_COOLDOWN_MS = 10_000;
const geoFailed           = new Map<string, number>();
let   geoFastest: string | null = null;
let   geoFastestMs               = Infinity;
let   geoAllFailedUntil          = 0;        // global cooldown after total blackout

// ── Shared fetch helper ───────────────────────────────────────────────────────

interface Pool {
  failed:        Map<string, number>;
  fastest:       string | null;
  fastestMs:     number;
  perMirrorMs:   number;
  blacklistMs:   number;
  setFastest:    (url: string, ms: number) => void;
  addFailed:     (url: string, until: number) => void;
}

const BULK_POOL: Pool = {
  failed:      bulkFailed,
  get fastest()   { return bulkFastest;   },
  get fastestMs() { return bulkFastestMs; },
  perMirrorMs: BULK_PER_MIRROR_MS,
  blacklistMs: BULK_BLACKLIST_MS,
  setFastest:  (url, ms) => { bulkFastest = url; bulkFastestMs = ms; },
  addFailed:   (url, until) => bulkFailed.set(url, until),
};

// ── Sequential fetch — used for heavy bulk viewport queries ──────────────────
// Tries mirrors one-by-one so we don't hammer every server with a multi-second
// scan simultaneously.
async function fetchWithMirrors(
  query:       string,
  pool:        Pool,
  userSignal?: AbortSignal,
): Promise<unknown> {
  const now = Date.now();

  let candidates = OVERPASS_MIRRORS.filter(
    url => (pool.failed.get(url) ?? 0) <= now,
  );

  if (candidates.length === 0) {
    console.warn('[overpassService] all mirrors blacklisted — resetting blacklist');
    pool.failed.clear();
    candidates = [...OVERPASS_MIRRORS];
  }

  const fastest = pool.fastest;
  if (fastest && candidates.includes(fastest) && candidates[0] !== fastest) {
    candidates = [fastest, ...candidates.filter(u => u !== fastest)];
  }

  const errors: string[] = [];

  for (const url of candidates) {
    if (userSignal?.aborted) throw Object.assign(new Error('Aborted'), { name: 'AbortError' });

    const mirrorCtrl  = new AbortController();
    const mirrorTimer = setTimeout(() => mirrorCtrl.abort(), pool.perMirrorMs);

    const forwardAbort = () => mirrorCtrl.abort();
    userSignal?.addEventListener('abort', forwardAbort);

    const host = url.split('/')[2];
    const t0   = Date.now();

    try {
      const res = await fetch(
        `${url}?data=${encodeURIComponent(query)}`,
        { signal: mirrorCtrl.signal },
      );

      clearTimeout(mirrorTimer);
      userSignal?.removeEventListener('abort', forwardAbort);

      if (res.ok) {
        const json    = await res.json();
        const elapsed = Date.now() - t0;
        if (elapsed < pool.fastestMs) pool.setFastest(url, elapsed);
        console.log(`[overpassService] ${host} OK in ${elapsed} ms`);
        return json;
      }

      if (res.status === 504 || res.status === 429 || res.status === 503) {
        pool.addFailed(url, now + pool.blacklistMs);
        console.warn(`[overpassService] ${host} → HTTP ${res.status} — blacklisted`);
        errors.push(`${host}:${res.status}`);
        continue;
      }

      throw new Error(`Overpass HTTP ${res.status}`);

    } catch (err) {
      clearTimeout(mirrorTimer);
      userSignal?.removeEventListener('abort', forwardAbort);

      if (err instanceof Error && err.name === 'AbortError') {
        if (userSignal?.aborted) throw err;
        pool.addFailed(url, now + pool.blacklistMs);
        console.warn(`[overpassService] ${host} → timeout — blacklisted`);
        errors.push(`${host}:timeout`);
        continue;
      }

      pool.addFailed(url, now + pool.blacklistMs);
      console.warn(`[overpassService] ${host} →`, err);
      errors.push(`${host}:err`);
    }
  }

  throw new Error(`All Overpass mirrors failed [${errors.join(' | ')}]`);
}

// ── Parallel fetch — used for lightweight geometry queries ───────────────────
// Geometry queries normally complete in <1 s on a healthy mirror.  Racing all
// candidates simultaneously means 3 instantly-dead mirrors don't add their
// failure latency to the total — only the fastest successful response matters.
// Sequential worst-case was GEO_PER_MIRROR_MS × N mirrors; parallel worst-case
// is GEO_PER_MIRROR_MS (the single slowest mirror that wins the race).
async function fetchGeoParallel(
  query:       string,
  userSignal?: AbortSignal,
): Promise<unknown> {
  const now = Date.now();

  if (now < geoAllFailedUntil) {
    throw new Error(
      `All Overpass mirrors on cooldown — retry in ${Math.ceil((geoAllFailedUntil - now) / 1000)} s`,
    );
  }

  let candidates = OVERPASS_MIRRORS.filter(url => (geoFailed.get(url) ?? 0) <= now);
  if (candidates.length === 0) {
    console.warn('[overpassService] all geo mirrors blacklisted — resetting');
    geoFailed.clear();
    candidates = [...OVERPASS_MIRRORS];
  }

  if (geoFastest && candidates.includes(geoFastest) && candidates[0] !== geoFastest) {
    candidates = [geoFastest, ...candidates.filter(u => u !== geoFastest)];
  }

  // One AbortController per mirror so the winner can cancel the rest
  const ctrls = candidates.map(() => new AbortController());

  const cancelAll = () => ctrls.forEach(c => c.abort());
  userSignal?.addEventListener('abort', cancelAll, { once: true });

  const attempts = candidates.map((url, i) => {
    const ctrl = ctrls[i];
    const host = url.split('/')[2];
    const t0   = Date.now();

    const timer = setTimeout(() => {
      geoFailed.set(url, now + GEO_BLACKLIST_MS);
      console.warn(`[overpassService] ${host} → geo timeout — blacklisted`);
      ctrl.abort();
    }, GEO_PER_MIRROR_MS);

    return fetch(`${url}?data=${encodeURIComponent(query)}`, { signal: ctrl.signal })
      .then(async res => {
        clearTimeout(timer);
        if (!res.ok) {
          if (res.status === 504 || res.status === 429 || res.status === 503) {
            geoFailed.set(url, now + GEO_BLACKLIST_MS);
          }
          throw new Error(`${host}:${res.status}`);
        }
        const json    = await res.json();
        const elapsed = Date.now() - t0;
        if (elapsed < geoFastestMs) { geoFastest = url; geoFastestMs = elapsed; }
        console.log(`[overpassService] ${host} OK in ${elapsed} ms`);
        return json;
      })
      .catch(err => {
        clearTimeout(timer);
        if (!(err instanceof Error && err.name === 'AbortError')) {
          geoFailed.set(url, now + GEO_BLACKLIST_MS);
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
    geoAllFailedUntil = now + GEO_ALL_FAIL_COOLDOWN_MS;
    throw new Error('All Overpass geo mirrors failed');
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
);
out center;`;
}

// ─── HTTP запрос ──────────────────────────────────────────────────────────────

export async function fetchParkingData(
  south: number, west: number, north: number, east: number,
  signal?: AbortSignal,
): Promise<OsmParking[]> {
  const query = buildOverpassQuery(south, west, north, east);
  const json  = await fetchWithMirrors(query, BULK_POOL, signal);
  return parseOverpassData(json as { elements: unknown[] });
}

// ─── Парсинг ответа Overpass ──────────────────────────────────────────────────

export function parseOverpassData(json: { elements: unknown[] }): OsmParking[] {
  return (json.elements as any[])
    .map(parseElement)
    .filter((p): p is OsmParking => p !== null);
}

function parseElement(el: any): OsmParking | null {
  const tags: Record<string, string> = el.tags ?? {};

  // ── node: только точка, геометрии нет ─────────────────────────────────────
  if (el.type === 'node') {
    return {
      id:       `n${el.id}`,
      position: { latitude: el.lat, longitude: el.lon },
      polygon:  null,
      polyline: null,
      tags,
    };
  }

  // ── way: контур через el.geometry ─────────────────────────────────────────
  if (el.type === 'way') {
    const coords = osmGeoToCoords(el.geometry ?? []);

    // el.center — предвычисленный центр, быстрее чем считать самому
    const position = el.center
      ? { latitude: el.center.lat, longitude: el.center.lon }
      : computeCenter(coords);

    // Замкнутый way (первая точка == последняя) → parking area → Polygon
    // Незамкнутый → parking lane / street_side → Polyline
    const closed = isClosed(coords);
    return {
      id:       `w${el.id}`,
      position,
      polygon:  closed && coords.length >= 3 ? coords : null,
      polyline: !closed && coords.length >= 2 ? coords : null,
      tags,
    };
  }

  // ── relation: берём outer-контур мультиполигона ───────────────────────────
  if (el.type === 'relation') {
    const outer  = (el.members ?? []).find(
      (m: any) => m.type === 'way' && m.role === 'outer',
    );
    const coords = osmGeoToCoords(outer?.geometry ?? []);
    const position = el.center
      ? { latitude: el.center.lat, longitude: el.center.lon }
      : computeCenter(coords);
    return {
      id:       `r${el.id}`,
      position,
      polygon:  coords.length >= 3 ? coords : null,
      polyline: null,
      tags,
    };
  }

  return null;
}

// ─── Вспомогательные ─────────────────────────────────────────────────────────

function osmGeoToCoords(geo: { lat: number; lon: number }[]): LatLng[] {
  return geo.map(g => ({ latitude: g.lat, longitude: g.lon }));
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

  const json = await fetchGeoParallel(query, signal);
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
  const outer  = (el.members ?? []).find(
    (m: any) => m.type === 'way' && m.role === 'outer',
  );
  const coords = osmGeoToCoords(outer?.geometry ?? []);
  return {
    polygon:  coords.length >= 3 ? coords : null,
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
  const json  = await fetchGeoParallel(query, signal);

  for (const el of ((json as { elements: unknown[] }).elements as any[])) {
    if (el.type === 'way') {
      const coords = osmGeoToCoords(el.geometry ?? []);
      const closed = isClosed(coords);
      result.set(`w${el.id}`, {
        polygon:  closed && coords.length >= 3 ? coords : null,
        polyline: !closed && coords.length >= 2 ? coords : null,
      });
    } else if (el.type === 'relation') {
      const outer  = (el.members ?? []).find(
        (m: any) => m.type === 'way' && m.role === 'outer',
      );
      const coords = osmGeoToCoords(outer?.geometry ?? []);
      result.set(`r${el.id}`, {
        polygon:  coords.length >= 3 ? coords : null,
        polyline: null,
      });
    }
  }

  return result;
}
