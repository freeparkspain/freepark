import { useMemo } from 'react';
import Supercluster from 'supercluster';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { deltaToZoom } from '../utils/geo';

// ─── Public types (unchanged — ParkingLayer depends on these) ─────────────────

export interface ClusterItem {
  type:     'cluster';
  id:       string;
  position: LatLng;
  count:    number;
}

export interface ParkingItem {
  type: 'parking';
  data: OsmParking;
}

export type LayerItem = ClusterItem | ParkingItem;

// ─── Internal supercluster point shape ───────────────────────────────────────

type PointProps = { parking: OsmParking };

// ─── Hook ─────────────────────────────────────────────────────────────────────
//
// Two-level memoisation:
//   1. index  — rebuilt only when `parkings` changes (O(n log n), rare)
//   2. items  — recomputed on every pan/zoom (O(log n), instant)
//
// Both run synchronously in the render cycle which is fine because:
//   • index build:  ~2–5 ms for 300 items, ~10 ms for 1 000
//   • getClusters:  < 1 ms regardless of dataset size
//
// The viewport bbox is required so supercluster can skip all tiles outside
// the screen — this is exactly what makes it faster than the old grid approach.

export const useClustering = (
  parkings:       OsmParking[],
  latitudeDelta:  number,
  viewportBounds: BBox,
): LayerItem[] => {

  // ── Level 1: build spatial index ──────────────────────────────────────────
  // Rebuild ONLY when the set of parking IDs changes (new spots discovered).
  // Geometry updates (polygon/polyline added to existing spots) change the
  // `parkings` array reference but NOT IDs or positions — no index rebuild
  // needed.  `parkings.length` is a safe proxy: IDs are immutable OSM
  // identifiers that are only ever added to the module cache, never removed.
  // ParkingLayer reads fresh geometry from its own `parkingMap` memo, so
  // stale parking objects inside the index features are harmless.
  const index = useMemo(() => {
    const sc = new Supercluster<PointProps>({
      radius:  60,   // pixel grouping radius at each zoom level
      // Cluster ONLY at far zoom. Above zoom 13 (medium + close views) points
      // are returned individually, so the "P" icons are never grouped when the
      // user is looking at a neighbourhood/street; clusters appear only when
      // zoomed out to district/city level.
      maxZoom: 13,
      minZoom: 1,
    });
    // Only feed finite, in-range coordinates to Supercluster — a NaN/Infinity
    // point makes getClusters() throw and crashes the whole map.
    sc.load(
      parkings
        .filter(p =>
          Number.isFinite(p.position.latitude) &&
          Number.isFinite(p.position.longitude) &&
          Math.abs(p.position.latitude)  <= 90 &&
          Math.abs(p.position.longitude) <= 180,
        )
        .map(p => ({
          type:       'Feature' as const,
          geometry:   {
            type:        'Point' as const,
            coordinates: [p.position.longitude, p.position.latitude],
          },
          properties: { parking: p },
        })),
    );
    return sc;
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [parkings.length]);

  // ── Level 2: query clusters for current viewport ──────────────────────────
  // Clamping zoom to [0, 20] guards against extreme latitudeDelta values.
  return useMemo(() => {
    // Guard against NaN/Infinity zoom (a transient bad latitudeDelta during a
    // camera animation) — getClusters(bbox, NaN) crashes Supercluster.
    const rawZoom = deltaToZoom(latitudeDelta);
    const zoom = Number.isFinite(rawZoom)
      ? Math.min(20, Math.max(0, Math.round(rawZoom)))
      : 14;

    const { west, south, east, north } = viewportBounds;
    // A non-finite bbox (bad region mid-animation) would also crash getClusters;
    // skip this frame safely — the next valid region re-queries.
    if (![west, south, east, north].every(Number.isFinite)) return [];

    const bbox: [number, number, number, number] = [west, south, east, north];

    return index.getClusters(bbox, zoom).map(feature => {
      const [lon, lat] = feature.geometry.coordinates;
      const position: LatLng = { latitude: lat, longitude: lon };
      const props = feature.properties as any;

      // Supercluster sets cluster:true on aggregated features
      if (props.cluster === true) {
        return {
          type:     'cluster' as const,
          id:       `c_${props.cluster_id as number}`,
          position,
          count:    props.point_count as number,
        };
      }

      return {
        type: 'parking' as const,
        data: (props as PointProps).parking,
      };
    });
  }, [index, latitudeDelta, viewportBounds]);
};
