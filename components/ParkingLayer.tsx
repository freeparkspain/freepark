import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker, Polygon, Polyline } from 'react-native-maps';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { useClustering, ClusterItem } from '../hooks/useClustering';
import { longestEdge } from '../utils/geo';
import { isPaidParking } from '../utils/parking';
import {
  ParkingMarker,
  PARKING_ACCENT, PARKING_ACCENT_DEEP,
  PAID_ACCENT, PAID_ACCENT_DEEP,
} from './ParkingMarker';

// ─── Geometry styles ──────────────────────────────────────────────────────────
// At rest, a park area is previewed as a single dashed *line* (its longest
// edge — see longestEdge) rather than its full rectangular outline, which for
// these long, narrow road-side bays reads as a "box" rather than a stripe.
// Tapping the icon swaps the preview line for the actual filled zone.
//
// Everything parking-related — badge, preview line, filled zone, clusters —
// shares one accent (PARKING_ACCENT). One colour family means a driver can
// tell "that's parking" at a glance instead of decoding a patchwork of
// one-off colours. Consistency *is* the decluttering: the eye learns one
// signal instead of several.

// At-rest preview: a thin dashed line tracing the area's longest edge.
// Paid zones use the same warm orange as the paid marker so a driver reads one
// consistent "this costs money" signal across marker + zone. Free stays blue.
const ZONE_LINE      = { color: PARKING_ACCENT, width: 3, dash: [9, 7] };
const ZONE_LINE_PAID = { color: PAID_ACCENT,    width: 3, dash: [9, 7] };
// Once another zone is selected, the rest fade to a faint trace — present
// enough to confirm "more parking this way" without competing for attention.
const ZONE_LINE_DIM      = { color: 'rgba(0,122,255,0.28)', width: 2.5, dash: [6, 8] };
const ZONE_LINE_DIM_PAID = { color: 'rgba(249,115,22,0.30)', width: 2.5, dash: [6, 8] };
// Selected: the real zone — full contour, solidly filled. What the preview
// line "becomes" once tapped.
const SELECTED_ZONE      = { fill: 'rgba(0,122,255,0.26)',  stroke: PARKING_ACCENT_DEEP, width: 3 };
const SELECTED_ZONE_PAID = { fill: 'rgba(249,115,22,0.24)', stroke: PAID_ACCENT_DEEP,    width: 3 };
// Genuine OSM polylines (street_side / lane parking — already line-shaped in
// the source data, unrelated to the zone-preview line above).
const LINE      = { color: PARKING_ACCENT, width: 8 };
const LINE_PAID = { color: PAID_ACCENT,    width: 8 };

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

// ─── Zone preview line (at-rest, unselected park areas) ───────────────────────
// Rendered only for individual (non-clustered) zones once the camera is close
// enough — see `showZonePolygons`. Previews each area as a single dashed line
// along its longest edge (longestEdge) — NOT its full rectangular outline,
// which for these long, narrow road-side bays reads as a "box" rather than a
// stripe. Tapping the icon swaps this preview for the actual filled zone (via
// SelectedGeometryLayer, which is why the selected zone is skipped here).
//
// `tappable` keeps the line itself a touch target too, alongside the badge —
// a forgiving way to select a long, thin shape without aiming for its centre.
//
// `dimmed` — true once *any* zone is selected elsewhere on screen. Fading the
// rest to a faint trace (ZONE_LINE_DIM) is the actual answer to "make it less
// cluttered": rather than showing every zone at full strength all the time,
// only the one the driver is interacting with stays crisp; the others remain
// just visible enough to say "parking continues this way" without competing.

const ZoneLine = memo(({ parking, dimmed, onPress }: {
  parking: OsmParking;
  dimmed:  boolean;
  onPress: (parking: OsmParking) => void;
}) => {
  if (!parking.polygon) return null;
  const edge = longestEdge(parking.polygon);
  if (!edge) return null;
  const paid  = isPaidParking(parking.tags);
  const style = dimmed
    ? (paid ? ZONE_LINE_DIM_PAID : ZONE_LINE_DIM)
    : (paid ? ZONE_LINE_PAID     : ZONE_LINE);
  return (
    <Polyline
      key={`zone-line-${parking.id}`}
      coordinates={edge}
      strokeColor={style.color}
      strokeWidth={style.width}
      lineDashPattern={style.dash}
      lineCap="round"
      zIndex={1}
      tappable
      onPress={() => onPress(parking)}
    />
  );
}, (prev, next) =>
  prev.parking.id === next.parking.id &&
  prev.dimmed     === next.dimmed &&
  prev.onPress    === next.onPress);

// ─── ParkingLayer ─────────────────────────────────────────────────────────────

interface Props {
  parkings:          OsmParking[];
  selectedParkingId: string | null;
  latitudeDelta:     number;
  viewportBounds:    BBox;
  onPressMarker:     (parking: OsmParking) => void;
  onPressCluster:    (position: LatLng) => void;
  selectedPolygon:   LatLng[] | null;
  selectedPolyline:  LatLng[] | null;
  geometryLoading:   boolean;
  /**
   * True while the camera is zoomed in close enough (<= park-area radius
   * threshold, decided by MapScreen) to show detailed zone outlines. When
   * false, only markers/clusters render — outlines hide until the user zooms
   * back in, keeping the far-out view to clean clustered icons.
   */
  showZonePolygons:  boolean;
}

export const ParkingLayer = memo(({
  parkings,
  selectedParkingId,
  latitudeDelta,
  viewportBounds,
  onPressMarker,
  onPressCluster,
  selectedPolygon,
  selectedPolyline,
  geometryLoading,
  showZonePolygons,
}: Props) => {

  const clusterItems = useClustering(parkings, latitudeDelta, viewportBounds);

  // The Supercluster index only rebuilds when new spots arrive (count changes),
  // not on geometry updates.  ZoneLine needs the LATEST polygon for each spot
  // (to show the zone outline once geometry loads), so we build a fresh id→spot
  // map from the `parkings` prop and use it for zone rendering.  O(n) map
  // creation is far cheaper than a full Supercluster rebuild.
  const parkingMap = useMemo(
    () => new Map(parkings.map(p => [p.id, p])),
    [parkings],
  );

  // Is the currently-selected parking paid? Drives the orange vs blue zone
  // styling so the selected polygon/line matches the marker's colour language.
  const selectedParking = selectedParkingId ? parkingMap.get(selectedParkingId) : undefined;
  const selectedPaid    = selectedParking ? isPaidParking(selectedParking.tags) : false;

  return (
    <>
      {/*
       * Geometry is isolated in its own subtree.  When a polygon loads or
       * clears, only SelectedGeometryLayer re-renders — the markers loop below
       * is completely unaffected.
       */}
      <SelectedGeometryLayer
        selectedParkingId={selectedParkingId}
        polygon={selectedPolygon}
        polyline={selectedPolyline}
        visible={showZonePolygons}
        paid={selectedPaid}
      />

      {/* ── Zone outlines — individual (non-clustered) areas only, close zoom only ──
       * Once one zone is selected, the rest dim — see ZoneLine's `dimmed` doc.
       * Uses parkingMap (not item.data) so ZoneLine always gets fresh geometry.
       */}
      {showZonePolygons && clusterItems.map(item =>
        item.type === 'parking' && item.data.id !== selectedParkingId
          ? (
            <ZoneLine
              key={`zone-${item.data.id}`}
              parking={parkingMap.get(item.data.id) ?? item.data}
              dimmed={!!selectedParkingId}
              onPress={onPressMarker}
            />
          )
          : null,
      )}

      {/* ── Markers / clusters ──────────────────────────────────────────────── */}
      {clusterItems.map(item =>
        item.type === 'cluster' ? (
          <ClusterMarker key={item.id} item={item} onPress={onPressCluster} />
        ) : (
          <ParkingMarker
            key={item.data.id}
            parking={item.data}
            isSelected={item.data.id === selectedParkingId}
            isLoadingGeometry={item.data.id === selectedParkingId && geometryLoading}
            onPress={onPressMarker}
          />
        ),
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
