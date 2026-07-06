import { BBox } from '../../types/parking';

// ─── Web-Mercator slippy-map tiles (pure, framework-free) ─────────────────────
// Deterministic {z}/{x}/{y} tile identity for the visible viewport, so parking
// loading/caching can key on stable tiles instead of arbitrary floating-point
// bounding boxes. A small pan then only touches new edge tiles. Unit-tested.

export interface TileId {
  z: number;
  x: number;
  y: number;
}

/** Stable string key for a tile — safe as a cache Map key. */
export function tileKey(t: TileId): string {
  return `${t.z}/${t.x}/${t.y}`;
}

/** Map a fractional camera zoom to a fixed parking DATA zoom (cache granularity). */
export function getParkingDataZoom(cameraZoom: number): number {
  if (!Number.isFinite(cameraZoom)) return 15;
  if (cameraZoom < 12) return 11;
  if (cameraZoom < 14) return 13;
  if (cameraZoom < 16) return 15;
  return 16;
}

/** Tile containing a lat/lng at the given zoom (standard slippy-map formula). */
export function latLngToTile(latitude: number, longitude: number, zoom: number): TileId {
  const z = Math.max(0, Math.floor(zoom));
  const n = 2 ** z;
  // Clamp latitude to Web Mercator's valid range before projecting.
  const lat = Math.max(-85.05112878, Math.min(85.05112878, latitude));
  const lon = ((longitude + 180) % 360 + 360) % 360 - 180; // wrap to [-180,180)
  const x = Math.floor(((lon + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.asinh(Math.tan(latRad)) / Math.PI) / 2) * n);
  const clamp = (v: number) => Math.max(0, Math.min(n - 1, v));
  return { z, x: clamp(x), y: clamp(y) };
}

/** Hard cap so a degenerate/huge bbox can never spin a giant tile list. */
export const MAX_TILES_PER_VIEWPORT = 64;

/**
 * All tiles covering `bounds` at `dataZoom`. Returns at most
 * MAX_TILES_PER_VIEWPORT tiles; a viewport needing more is "too large" (the
 * caller should ask the user to zoom in rather than request a whole city).
 */
export function getVisibleTileIds(bounds: BBox, dataZoom: number): TileId[] {
  const { north, south, east, west } = bounds;
  if (![north, south, east, west].every(Number.isFinite) || north < south || east < west) {
    return [];
  }
  const nw = latLngToTile(north, west, dataZoom);
  const se = latLngToTile(south, east, dataZoom);

  const tiles: TileId[] = [];
  for (let x = nw.x; x <= se.x; x++) {
    for (let y = nw.y; y <= se.y; y++) {
      tiles.push({ z: dataZoom, x, y });
      if (tiles.length >= MAX_TILES_PER_VIEWPORT) return tiles;
    }
  }
  return tiles;
}
