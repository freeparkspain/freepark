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

const OVERPASS_URL = 'https://overpass-api.de/api/interpreter';

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
  const res   = await fetch(`${OVERPASS_URL}?data=${encodeURIComponent(query)}`, { signal });
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);
  return parseOverpassData(await res.json());
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

  const type  = prefix === 'w' ? 'way' : 'relation';
  const query = `[out:json][timeout:10]; ${type}(${numId}); out geom;`;

  const res = await fetch(
    `${OVERPASS_URL}?data=${encodeURIComponent(query)}`,
    { signal },
  );
  if (!res.ok) throw new Error(`Overpass HTTP ${res.status}`);

  const el = ((await res.json()).elements as any[])[0];
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
