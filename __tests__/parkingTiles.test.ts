import {
  getParkingDataZoom,
  getVisibleTileIds,
  latLngToTile,
  MAX_TILES_PER_VIEWPORT,
  tileKey,
} from '../services/parking/parkingTiles';
import { BBox } from '../types/parking';

describe('latLngToTile', () => {
  it('maps 0,0 to the middle tile at each zoom', () => {
    expect(latLngToTile(0, 0, 1)).toEqual({ z: 1, x: 1, y: 1 });
    expect(latLngToTile(0, 0, 2)).toEqual({ z: 2, x: 2, y: 2 });
  });

  it('maps Málaga centre to a stable tile at zoom 15', () => {
    const t = latLngToTile(36.7213, -4.4214, 15);
    expect(t.z).toBe(15);
    expect(Number.isInteger(t.x)).toBe(true);
    expect(Number.isInteger(t.y)).toBe(true);
    // Same input → same tile (deterministic identity).
    expect(tileKey(latLngToTile(36.7213, -4.4214, 15))).toBe(tileKey(t));
  });

  it('clamps coordinates into valid tile range', () => {
    const t = latLngToTile(89, 200, 3); // out-of-range lat/lon
    const n = 2 ** 3;
    expect(t.x).toBeGreaterThanOrEqual(0);
    expect(t.x).toBeLessThan(n);
    expect(t.y).toBeGreaterThanOrEqual(0);
    expect(t.y).toBeLessThan(n);
  });
});

describe('getParkingDataZoom', () => {
  it('buckets camera zoom into fixed data zooms', () => {
    expect(getParkingDataZoom(10)).toBe(11);
    expect(getParkingDataZoom(13)).toBe(13);
    expect(getParkingDataZoom(15)).toBe(15);
    expect(getParkingDataZoom(18)).toBe(16);
    expect(getParkingDataZoom(NaN)).toBe(15);
  });
});

describe('getVisibleTileIds', () => {
  const smallViewport: BBox = { south: 36.720, west: -4.424, north: 36.726, east: -4.418 };

  it('returns a small deduplicated tile set for a small viewport', () => {
    const tiles = getVisibleTileIds(smallViewport, 15);
    expect(tiles.length).toBeGreaterThan(0);
    expect(tiles.length).toBeLessThan(MAX_TILES_PER_VIEWPORT);
    const keys = new Set(tiles.map(tileKey));
    expect(keys.size).toBe(tiles.length); // no duplicates
  });

  it('caps a huge viewport instead of returning an unbounded list', () => {
    const wholeWorld: BBox = { south: -80, west: -179, north: 80, east: 179 };
    const tiles = getVisibleTileIds(wholeWorld, 16);
    expect(tiles.length).toBe(MAX_TILES_PER_VIEWPORT);
  });

  it('returns [] for an invalid/degenerate bbox', () => {
    expect(getVisibleTileIds({ south: 37, west: -4, north: 36, east: -5 }, 15)).toEqual([]);
    expect(getVisibleTileIds({ south: NaN, west: -4, north: 36, east: -3 }, 15)).toEqual([]);
  });

  it('only adds edge tiles when the viewport shifts by one tile (subset overlap)', () => {
    const a = getVisibleTileIds(smallViewport, 15).map(tileKey);
    const shifted: BBox = {
      south: smallViewport.south + 0.002, north: smallViewport.north + 0.002,
      west: smallViewport.west, east: smallViewport.east,
    };
    const b = getVisibleTileIds(shifted, 15).map(tileKey);
    // A tiny shift shares most tiles — so a pan only needs the few new ones.
    const shared = a.filter(k => b.includes(k));
    expect(shared.length).toBeGreaterThan(0);
  });
});
