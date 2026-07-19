import { useMemo } from 'react';
import Supercluster from 'supercluster';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { deltaToZoom } from '../utils/geo';
import { parkingClusterSignature } from '../utils/parkingCluster';

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

// Fraction of the viewport span added as a margin on each side before querying
// Supercluster. Supercluster only returns points INSIDE the bbox, so an
// un-padded viewport makes markers sitting exactly on the visible edge blink out
// the moment the user pans or zooms. A margin keeps those boundary markers
// rendered so icons don't disappear during map movement.
const VIEWPORT_PAD_RATIO = 0.3;

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

  const indexSignature = parkingClusterSignature(parkings);

  // ── Level 1: build spatial index ──────────────────────────────────────────
  // Rebuild only when IDs or positions change. Geometry/tag-only updates keep
  // the same signature, while replacing the selected parking with a different
  // object of equal array length still rebuilds and cannot leave a duplicate in
  // the native marker layer.
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
  }, [indexSignature]);

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

    // Pad the query bbox so markers on the visible edge stay rendered through a
    // pan/zoom (see VIEWPORT_PAD_RATIO). Clamp to valid lat/lon so an extreme
    // viewport can't hand Supercluster an out-of-range bbox.
    const padLon = (east - west) * VIEWPORT_PAD_RATIO;
    const padLat = (north - south) * VIEWPORT_PAD_RATIO;
    const bbox: [number, number, number, number] = [
      Math.max(-180, west  - padLon),
      Math.max(-90,  south - padLat),
      Math.min(180,  east  + padLon),
      Math.min(90,   north + padLat),
    ];

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
