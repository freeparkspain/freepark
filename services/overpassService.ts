/**
 * overpassService.ts
 *
 * Загружает парковки из OpenStreetMap через Overpass API.
 *
 * ── Overpass QL запрос ──────────────────────────────────────────────────────
 *
 *   [out:json][timeout:25][maxsize:2000000]
 *   (
 *     node["amenity"="parking"](bbox);
 *     way["amenity"="parking"](bbox);
 *     relation["amenity"="parking"](bbox);
 *     way["parking"="street_side"](bbox);
 *     way["parking"="lane"](bbox);
 *   );
 *   out center geom;
 *
 * [maxsize:2000000] → сервер обрежет ответ при превышении 2 MB.
 * out center geom   → для way/relation возвращает:
 *   - center: {lat, lon}        — центральная точка (для иконки маркера)
 *   - geometry: [{lat, lon}…]   — контур (для Polygon / Polyline)
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

// ─── Mirror rotation with blacklisting ───────────────────────────────────────

const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://lz4.overpass-api.de/api/interpreter',
  'https://overpass.nchc.org.tw/api/interpreter',
];

/** Fail fast per mirror — single-element geometry queries should return in < 1 s. */
const PER_MIRROR_TIMEOUT_MS  = 3_500;
/** How long a misbehaving mirror stays out of rotation. */
const MIRROR_BLACKLIST_MS    = 5 * 60 * 1_000; // 5 minutes

// Module-level state — both survive across calls within the same JS session.
/** url → Unix-ms timestamp when the blacklist expires. */
const failedMirrors = new Map<string, number>();
/** The mirror that responded fastest in any previous call; tried first next time. */
let fastestMirror: string | null = null;
let fastestTimeMs: number        = Infinity;

/**
 * Executes an Overpass QL query with automatic mirror rotation.
 *
 * Selection order each call:
 *   1. Non-blacklisted mirrors, with the known-fastest mirror promoted to front.
 *   2. If every mirror is blacklisted the blacklist is fully reset first.
 *
 * A mirror is blacklisted for MIRROR_BLACKLIST_MS on:
 *   • HTTP 504 / 429 / 503
 *   • Client-side timeout (PER_MIRROR_TIMEOUT_MS elapsed)
 *   • Network / fetch error
 *
 * Non-transient HTTP errors (400, 404 …) propagate immediately without retry.
 * The caller's AbortSignal is forwarded so cancellation is always instant.
 */
async function fetchWithMirrors(
  query:       string,
  userSignal?: AbortSignal,
): Promise<unknown> {
  const now = Date.now();

  // Build candidate list: exclude currently-blacklisted mirrors
  let candidates = OVERPASS_MIRRORS.filter(
    url => (failedMirrors.get(url) ?? 0) <= now,
  );

  // Safety valve: if everything is blacklisted, reset and try all mirrors again
  if (candidates.length === 0) {
    console.warn('[overpassService] all mirrors blacklisted — resetting blacklist');
    failedMirrors.clear();
    candidates = [...OVERPASS_MIRRORS];
  }

  // Promote the empirically fastest mirror to index 0
  if (fastestMirror && candidates.includes(fastestMirror) && candidates[0] !== fastestMirror) {
    candidates = [fastestMirror, ...candidates.filter(u => u !== fastestMirror)];
  }

  const errors: string[] = [];

  for (const url of candidates) {
    if (userSignal?.aborted) throw new DOMException('Aborted', 'AbortError');

    const mirrorCtrl  = new AbortController();
    const mirrorTimer = setTimeout(() => mirrorCtrl.abort(), PER_MIRROR_TIMEOUT_MS);

    // Forward caller cancellation so in-flight fetches die immediately
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
        // Update fastest-mirror record
        if (elapsed < fastestTimeMs) {
          fastestTimeMs = elapsed;
          fastestMirror = url;
        }
        console.log(`[overpassService] ${host} OK in ${elapsed} ms`);
        return json;
      }

      // Transient server trouble — blacklist and try the next mirror
      if (res.status === 504 || res.status === 429 || res.status === 503) {
        failedMirrors.set(url, now + MIRROR_BLACKLIST_MS);
        console.warn(`[overpassService] ${host} → HTTP ${res.status} — blacklisted 5 min`);
        errors.push(`${host}:${res.status}`);
        continue;
      }

      // Permanent error — propagate without retry
      throw new Error(`Overpass HTTP ${res.status}`);

    } catch (err) {
      clearTimeout(mirrorTimer);
      userSignal?.removeEventListener('abort', forwardAbort);

      if (err instanceof Error && err.name === 'AbortError') {
        if (userSignal?.aborted) throw err;                      // propagate caller cancel
        failedMirrors.set(url, now + MIRROR_BLACKLIST_MS);
        console.warn(`[overpassService] ${host} → timeout — blacklisted 5 min`);
        errors.push(`${host}:timeout`);
        continue;
      }

      // Network / JSON parse error — blacklist and try next
      failedMirrors.set(url, now + MIRROR_BLACKLIST_MS);
      console.warn(`[overpassService] ${host} →`, err);
      errors.push(`${host}:err`);
    }
  }

  throw new Error(`All Overpass mirrors failed [${errors.join(' | ')}]`);
}

// ─── Запрос ───────────────────────────────────────────────────────────────────

export function buildOverpassQuery(
  south: number, west: number, north: number, east: number,
): string {
  const bbox = `${south},${west},${north},${east}`;
  // out center — centroid only; no ring geometry. Fast, small payload.
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
  const json  = await fetchWithMirrors(query, signal);
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

  const json = await fetchWithMirrors(query, signal);
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
