import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker, Polygon, Polyline } from 'react-native-maps';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { useClustering, ClusterItem } from '../hooks/useClustering';
import { isPaidParking } from '../utils/parking';
import { ParkingLod, ZONE_SIMPLIFY_TOLERANCE_M } from '../constants/parkingLod';
import { simplifiedZoneGeometry } from '../utils/parkingGeometry';
import {
  ParkingMarker,
  PARKING_ACCENT, PARKING_ACCENT_DEEP,
  PAID_ACCENT, PAID_ACCENT_DEEP,
} from './ParkingMarker';
import { SELECTED_ZONE, SELECTED_ZONE_PAID } from '../constants/parkingZoneTheme';

// ─── Geometry styles ──────────────────────────────────────────────────────────
// Parking-zone boundaries are drawn as CONTINUOUS SOLID lines (no dashes) so a
// bay outline reads as one shape instead of broken segments. Everything
// parking-related — badge, zone outline, filled selected zone, clusters — shares
// one accent family (blue = free, orange = paid) so the whole layer reads as a
// single visual language rather than a patchwork of one-off colours.
//
// Non-selected zone outline: solid stroke, no fill, so many on-screen zones stay
// legible without muddying the map. Free = blue, paid = orange (matches marker).
const ZONE_OUTLINE      = { stroke: PARKING_ACCENT, width: 3 };
const ZONE_OUTLINE_PAID = { stroke: PAID_ACCENT,    width: 3 };
// Selected zone styles live in the pure, unit-testable ../constants/
// parkingZoneTheme module — imported above (stronger fill, still a solid stroke).
// Genuine OSM polylines (street_side / lane parking) for the SELECTED zone. Blue
// (free) / orange (paid) to match the markers.
const LINE      = { color: PARKING_ACCENT, width: 6 };
const LINE_PAID = { color: PAID_ACCENT,    width: 6 };

// ─── SelectedGeometryLayer ────────────────────────────────────────────────────
// Isolated into its own memo'd component so that polygon load / unload events
// (which change `polygon` / `polyline` frequently) never trigger a reconcile
// of the markers loop below.  The two subtrees are now fully decoupled.

interface GeometryLayerProps {
  selectedParkingId: string | null;
  polygon:           LatLng[] | null;
  polyline:          LatLng[] | null;
  visible:           boolean;
  paid:              boolean;
}

const SelectedGeometryLayer = memo(({
  selectedParkingId,
  polygon,
  polyline,
  visible,
  paid,
}: GeometryLayerProps) => {
  const zone = paid ? SELECTED_ZONE_PAID : SELECTED_ZONE;
  const line = paid ? LINE_PAID : LINE;
  return (
    <>
      {visible && polygon && selectedParkingId && (
        <Polygon
          key={`zone-selected-${selectedParkingId}`}
          coordinates={polygon}
          fillColor={zone.fill}
          strokeColor={zone.stroke}
          strokeWidth={zone.width}
          lineJoin="round"
          lineCap="round"
          zIndex={2}
        />
      )}
      {visible && polyline && !polygon && selectedParkingId && (
        <Polyline
          key={`line-${selectedParkingId}`}
          coordinates={polyline}
          strokeColor={line.color}
          strokeWidth={line.width}
          lineCap="round"
          lineJoin="round"
          zIndex={2}
        />
      )}
    </>
  );
});

// ─── Cluster marker ───────────────────────────────────────────────────────────

function clusterDim(count: number): { size: number; fontSize: number } {
  if (count < 10)  return { size: 32, fontSize: 12 };
  if (count < 50)  return { size: 40, fontSize: 13 };
  return                  { size: 48, fontSize: 14 };
}

const ClusterMarker = memo(({ item, onPress }: {
  item:    ClusterItem;
  onPress: (position: LatLng) => void;
}) => {
  const { size, fontSize } = clusterDim(item.count);
  return (
    <Marker
      coordinate={item.position}
      tracksViewChanges={false}
      anchor={{ x: 0.5, y: 0.5 }}
      onPress={() => onPress(item.position)}
    >
      <View
        style={[styles.cluster, { width: size, height: size, borderRadius: size / 2 }]}
        renderToHardwareTextureAndroid={Platform.OS === 'android'}
        // @ts-ignore
        shouldRasterizeIOS={Platform.OS === 'ios'}
        collapsable={false}
      >
        <Text style={[styles.clusterText, { fontSize }]}>{item.count}</Text>
      </View>
    </Marker>
  );
}, (prev, next) =>
  // Only re-render when the cluster itself changes (position or count).
  // `onPress` is now stable (stable callback in MapScreen), so we don't need
  // to check it here — but even if it changed, the visual output would be
  // identical, so skipping it saves O(clusters) native marker updates per pan.
  prev.item.id    === next.item.id &&
  prev.item.count === next.item.count);

// ─── Zone outline (LOD: medium = simplified, high = full) ─────────────────────
// Renders an individual (non-clustered) park area's boundary as a SOLID line —
// a fill-less Polygon for a valid closed ring, a Polyline for open geometry.
// At medium zoom the geometry is simplified (cached RDP — see
// simplifiedZoneGeometry) to cut vertex counts; at high zoom the full ring is
// drawn. The line stays tappable so a long, thin bay can be selected without
// aiming for the tiny badge at its centre. The SELECTED zone is drawn separately
// (SelectedGeometryLayer) and is excluded from this loop via clusterInput.

const ZoneOutline = memo(({ parking, simplified, onPress }: {
  parking:    OsmParking;
  simplified: boolean;
  onPress:    (parking: OsmParking) => void;
}) => {
  const paid  = isPaidParking(parking.tags);
  const style = paid ? ZONE_OUTLINE_PAID : ZONE_OUTLINE;

  // Prefer a closed polygon ring; fall back to an open polyline.
  if (parking.polygon && parking.polygon.length >= 4) {
    const coords = simplified
      ? simplifiedZoneGeometry(parking.polygon, ZONE_SIMPLIFY_TOLERANCE_M, 4)
      : parking.polygon;
    return (
      <Polygon
        coordinates={coords}
        strokeColor={style.stroke}
        strokeWidth={style.width}
        fillColor="rgba(0,0,0,0)"
        lineJoin="round"
        lineCap="round"
        tappable
        onPress={() => onPress(parking)}
        zIndex={1}
      />
    );
  }
  if (parking.polyline && parking.polyline.length >= 2) {
    const coords = simplified
      ? simplifiedZoneGeometry(parking.polyline, ZONE_SIMPLIFY_TOLERANCE_M, 2)
      : parking.polyline;
    return (
      <Polyline
        coordinates={coords}
        strokeColor={style.stroke}
        strokeWidth={style.width}
        lineCap="round"
        lineJoin="round"
        tappable
        onPress={() => onPress(parking)}
        zIndex={1}
      />
    );
  }
  return null;
}, (prev, next) =>
  // Visual output depends only on identity, geometry reference and the
  // simplified flag — NOT onPress (excluded so a new handler ref never forces an
  // O(zones) native reconcile; the handler reads live state via refs upstream).
  prev.parking.id       === next.parking.id &&
  prev.parking.polygon  === next.parking.polygon &&
  prev.parking.polyline === next.parking.polyline &&
  prev.simplified       === next.simplified);

// ─── ParkingLayer ─────────────────────────────────────────────────────────────

// Safety cap on simultaneously-rendered individual (non-clustered) markers.
// Clustering normally keeps the on-screen count far below this; the cap only
// guards against a pathological viewport trying to mount thousands at once.
const MAX_INDIVIDUAL_MARKERS = 150;
// Independent cap for zone outlines (only zones that actually carry geometry are
// ever drawn, so this rarely bites — it just bounds the worst case).
const MAX_ZONE_OUTLINES = 120;

interface Props {
  parkings:          OsmParking[];
  /** Persistent snapshot of the selected parking (Bug 2) — rendered from this,
   *  independent of clustering/viewport, so a small camera move can't hide it. */
  selectedParking:   OsmParking | null;
  latitudeDelta:     number;
  viewportBounds:    BBox;
  onPressMarker:     (parking: OsmParking) => void;
  onPressCluster:    (position: LatLng) => void;
  selectedPolygon:   LatLng[] | null;
  selectedPolyline:  LatLng[] | null;
  /**
   * Level of Detail for zone geometry (centralised in constants/parkingLod):
   *   'low'    → markers/clusters only, no zone outlines
   *   'medium' → simplified, solid zone outlines
   *   'high'   → full-resolution solid zone outlines
   * Markers always render at every level — LOD only switches the geometry.
   */
  lod: ParkingLod;
}

export const ParkingLayer = memo(({
  parkings,
  selectedParking,
  latitudeDelta,
  viewportBounds,
  onPressMarker,
  onPressCluster,
  selectedPolygon,
  selectedPolyline,
  lod,
}: Props) => {

  const selectedParkingId = selectedParking?.id ?? null;

  // Exclude the selected parking from clustering so it can NEVER be aggregated
  // into a cluster bubble (which would hide its individual marker on a small
  // pan/zoom). It is rendered separately, always-on, from the snapshot below.
  const clusterInput = useMemo(
    () => (selectedParkingId ? parkings.filter(p => p.id !== selectedParkingId) : parkings),
    [parkings, selectedParkingId],
  );

  const clusterItems = useClustering(clusterInput, latitudeDelta, viewportBounds);

  // Fresh id→spot map so ZoneOutline always reads the latest geometry for an id
  // (the cluster index can hold an older parking object). Cheaper than a
  // Supercluster rebuild.
  const parkingMap = useMemo(
    () => new Map(parkings.map(p => [p.id, p])),
    [parkings],
  );

  const selectedPaid = selectedParking ? isPaidParking(selectedParking.tags) : false;

  return (
    <>
      {/* ── Zone outlines — individual (non-clustered) areas, medium/high LOD ──
       * Solid boundaries (no dashes). Simplified at medium zoom, full at high;
       * skipped entirely at low zoom (markers only). Uses parkingMap (not
       * item.data) so the outline always gets fresh geometry. The selected zone
       * is drawn separately below and excluded from clustering. Capped as a
       * safety net against a pathological viewport.
       */}
      {lod !== 'low' && (() => {
        let shown = 0;
        return clusterItems.map(item => {
          if (item.type !== 'parking') return null;
          const p = parkingMap.get(item.data.id) ?? item.data;
          if ((!p.polygon && !p.polyline) || shown >= MAX_ZONE_OUTLINES) return null;
          shown++;
          return (
            <ZoneOutline
              key={`zone-${p.id}`}
              parking={p}
              simplified={lod === 'medium'}
              onPress={onPressMarker}
            />
          );
        });
      })()}

      {/* ── Markers / clusters (selected parking excluded — rendered below) ────
       * Individual markers are capped as a safety net: clustering already keeps
       * the on-screen count small, but a pathological viewport must never try to
       * mount thousands of native custom-view markers (jank / OOM). Clusters are
       * always rendered; individual markers beyond MAX_INDIVIDUAL_MARKERS are
       * dropped (the user zooms in to resolve them).
       */}
      {(() => {
        let individualShown = 0;
        return clusterItems.map(item => {
          if (item.type === 'cluster') {
            return <ClusterMarker key={item.id} item={item} onPress={onPressCluster} />;
          }
          if (individualShown >= MAX_INDIVIDUAL_MARKERS) return null;
          individualShown++;
          return (
            <ParkingMarker
              key={item.data.id}
              parking={item.data}
              isSelected={false}
              onPress={onPressMarker}
            />
          );
        });
      })()}

      {/* ── Selected parking — persistent overlay (Bug 2) ─────────────────────
       * Rendered from the snapshot, ABOVE clusters, and its zone is NOT gated by
       * the LOD — so the selected marker + zone stay put through pan, zoom,
       * rotate and tilt until the user selects another or closes it.
       */}
      {selectedParking && (
        <SelectedGeometryLayer
          // Key by the selected id so switching selection REMOUNTS the whole
          // geometry subtree — this forces the old native Polygon/Polyline to
          // unmount (react-native-maps/Google can otherwise leave a removed
          // polygon on screen), fixing "the old zone doesn't always disappear".
          key={`sel-geom-${selectedParking.id}`}
          selectedParkingId={selectedParkingId}
          polygon={selectedPolygon}
          polyline={selectedPolyline}
          visible
          paid={selectedPaid}
        />
      )}
      {selectedParking && (
        <ParkingMarker
          key={`selected-parking-${selectedParking.id}`}
          parking={selectedParking}
          isSelected
          onPress={onPressMarker}
        />
      )}
    </>
  );
});

const styles = StyleSheet.create({
  cluster: {
    backgroundColor: PARKING_ACCENT_DEEP,
    borderWidth:     2.5,
    borderColor:     '#ffffff',
    justifyContent:  'center',
    alignItems:      'center',
    // No shadow/elevation — on Android elevation drew a gray square behind the
    // circular bubble at some zoom levels. The white border keeps it legible.
  },
  clusterText: { color: '#ffffff', fontWeight: '800' },
});
