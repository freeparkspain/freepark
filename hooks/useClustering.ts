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
  // Supercluster uses a static R-tree internally, so this is the expensive
  // step. We memo on `parkings` identity — new fetches produce a new array
  // reference, which triggers a rebuild. Panning/zooming does not.
  const index = useMemo(() => {
    const sc = new Supercluster<PointProps>({
      radius:  60,   // pixel grouping radius at each zoom level
      maxZoom: 16,   // individual markers above zoom 16
      minZoom: 1,
    });
    sc.load(
      parkings.map(p => ({
        type:       'Feature' as const,
        geometry:   {
          type:        'Point' as const,
          coordinates: [p.position.longitude, p.position.latitude],
        },
        properties: { parking: p },
      })),
    );
    return sc;
  }, [parkings]);

  // ── Level 2: query clusters for current viewport ──────────────────────────
  // Clamping zoom to [0, 20] guards against extreme latitudeDelta values.
  return useMemo(() => {
    const zoom = Math.min(20, Math.max(0, Math.round(deltaToZoom(latitudeDelta))));
    const bbox: [number, number, number, number] = [
      viewportBounds.west,
      viewportBounds.south,
      viewportBounds.east,
      viewportBounds.north,
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
