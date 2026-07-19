import React, { memo, useMemo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker, Polygon, Polyline } from 'react-native-maps';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { useClustering, ClusterItem } from '../hooks/useClustering';
import { isPaidParking } from '../utils/parking';
import {
  PARKING_LOD_PRESENTATION,
  ParkingLod,
  ZONE_SIMPLIFY_TOLERANCE_M,
} from '../constants/parkingLod';
import { parkingRenderGeometry, simplifyRenderGeometry } from '../utils/parkingGeometry';
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

// A visible street segment is too narrow to hit accurately with a thumb. This
// almost-transparent underlay creates a forgiving touch target without adding
// visual weight. A tiny alpha is intentional because fully transparent map
// overlays are not reliably tappable on Android.
const LINE_TOUCH_COLOR = 'rgba(15,23,42,0.01)';
const LINE_TOUCH_WIDTH = 20;

// ─── SelectedGeometryLayer ────────────────────────────────────────────────────
// Isolated into its own memo'd component so that polygon load / unload events
// (which change `polygon` / `polyline` frequently) never trigger a reconcile
// of the markers loop below.  The two subtrees are now fully decoupled.

interface GeometryLayerProps {
  parking:            OsmParking;
  polygon:           LatLng[] | null;
  polyline:          LatLng[] | null;
  visible:           boolean;
  paid:              boolean;
}

const hasPolygonGeometry = (geometry: LatLng[] | null): geometry is LatLng[] =>
  Boolean(geometry && geometry.length >= 4);

const hasPolylineGeometry = (geometry: LatLng[] | null): geometry is LatLng[] =>
  Boolean(geometry && geometry.length >= 2);

const SelectedGeometryLayer = memo(({
  parking,
  polygon,
  polyline,
  visible,
  paid,
}: GeometryLayerProps) => {
  const zone = paid ? SELECTED_ZONE_PAID : SELECTED_ZONE;
  const line = paid ? LINE_PAID : LINE;
  const renderGeometry = parkingRenderGeometry(parking.tags, polygon, polyline);
  const hasPolygon = hasPolygonGeometry(renderGeometry.polygon);
  return (
    <>
      {visible && hasPolygon && (
        <Polygon
          key={`zone-selected-${parking.id}`}
          coordinates={renderGeometry.polygon!}
          fillColor={zone.fill}
          strokeColor={zone.stroke}
          strokeWidth={zone.width}
          lineJoin="round"
          lineCap="round"
          zIndex={2}
        />
      )}
      {visible && !hasPolygon && renderGeometry.lines.map(renderLine => (
        <Polyline
          key={`line-selected-${parking.id}-${renderLine.side}`}
          coordinates={renderLine.coordinates}
          strokeColor={line.color}
          strokeWidth={line.width}
          lineCap="round"
          lineJoin="round"
          zIndex={2}
        />
      ))}
    </>
  );
});
SelectedGeometryLayer.displayName = 'SelectedGeometryLayer';

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
  prev.item.count === next.item.count &&
  prev.item.position.latitude === next.item.position.latitude &&
  prev.item.position.longitude === next.item.position.longitude);
ClusterMarker.displayName = 'ClusterMarker';

// ─── Zone outline (LOD: medium = simplified, high = full) ─────────────────────
// Renders an individual (non-clustered) park area's boundary as a SOLID line —
// a fill-less Polygon for a valid closed ring, a Polyline for open geometry.
// At medium zoom the geometry is simplified (cached RDP — see
// simplifiedZoneGeometry) to cut vertex counts; at high zoom the full ring is
// drawn. The line stays tappable so a long, thin bay can be selected without
// aiming for the tiny badge at its centre. The SELECTED zone is drawn separately
// (SelectedGeometryLayer) and is excluded from this loop via zoneParkings.

const ZoneOutline = memo(({ parking, simplified, onPress }: {
  parking:    OsmParking;
  simplified: boolean;
  onPress:    (parking: OsmParking) => void;
}) => {
  const paid  = isPaidParking(parking.tags);
  const style = paid ? ZONE_OUTLINE_PAID : ZONE_OUTLINE;
  // Build render geometry (polygon ring / left-right street offsets) from the
  // FULL-resolution OSM geometry first, THEN simplify the result — never the
  // other way around. See simplifyRenderGeometry for why simplifying the
  // centerline before offsetting broke zone shapes at medium zoom.
  const fullGeometry = parkingRenderGeometry(parking.tags, parking.polygon, parking.polyline);
  const renderGeometry = simplified
    ? simplifyRenderGeometry(fullGeometry, ZONE_SIMPLIFY_TOLERANCE_M)
    : fullGeometry;

  if (renderGeometry.polygon) {
    return (
      <Polygon
        coordinates={renderGeometry.polygon}
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
  if (renderGeometry.lines.length > 0) {
    return (
      <>
        {renderGeometry.lines.map(renderLine => (
          <React.Fragment key={`${parking.id}-${renderLine.side}`}>
            <Polyline
              coordinates={renderLine.coordinates}
              strokeColor={LINE_TOUCH_COLOR}
              strokeWidth={LINE_TOUCH_WIDTH}
              lineCap="round"
              lineJoin="round"
              tappable
              onPress={() => onPress(parking)}
              zIndex={1}
            />
            <Polyline
              coordinates={renderLine.coordinates}
              strokeColor={style.stroke}
              strokeWidth={style.width}
              lineCap="round"
              lineJoin="round"
              tappable
              onPress={() => onPress(parking)}
              zIndex={2}
            />
          </React.Fragment>
        ))}
      </>
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
  prev.parking.tags.__parking_geometry === next.parking.tags.__parking_geometry &&
  prev.parking.tags.__parking_sides === next.parking.tags.__parking_sides &&
  prev.parking.tags.parking === next.parking.tags.parking &&
  isPaidParking(prev.parking.tags) === isPaidParking(next.parking.tags) &&
  prev.simplified       === next.simplified);
ZoneOutline.displayName = 'ZoneOutline';

// Point-only OSM objects still need to remain discoverable while their geometry
// is loading (or when none exists). A restrained dot avoids bringing the noisy
// "P" badges back into zone mode.
const GeometryFallbackMarker = memo(({ parking, selected, onPress }: {
  parking: OsmParking;
  selected: boolean;
  onPress: (parking: OsmParking) => void;
}) => (
  <Marker
    coordinate={parking.position}
    tracksViewChanges={false}
    anchor={{ x: 0.5, y: 0.5 }}
    zIndex={selected ? 5 : 1}
    onPress={() => onPress(parking)}
  >
    <View style={[styles.fallbackHitArea, selected && styles.fallbackHitAreaSelected]}>
      <View style={[styles.fallbackDot, selected && styles.fallbackDotSelected]} />
    </View>
  </Marker>
), (prev, next) =>
  prev.parking.id === next.parking.id &&
  prev.selected === next.selected);
GeometryFallbackMarker.displayName = 'GeometryFallbackMarker';

// ─── ParkingLayer ─────────────────────────────────────────────────────────────

// Safety cap on simultaneously-rendered individual (non-clustered) markers.
// Clustering normally keeps the on-screen count far below this; the cap only
// guards against a pathological viewport trying to mount thousands at once.
const MAX_INDIVIDUAL_MARKERS = 150;
// Independent cap for zone outlines (only zones that actually carry geometry are
// ever drawn, so this rarely bites — it just bounds the worst case).
const MAX_ZONE_OUTLINES = 120;
// How far beyond the strict viewport zone outlines stay mounted (fraction of
// the viewport span) — see the comment above zoneParkings. Half of
// useClustering's own VIEWPORT_PAD_RATIO (0.3): zone geometry is heavier to
// render than a marker icon, so the buffer is kept tighter while still
// bounded by MAX_ZONE_OUTLINES regardless.
const ZONE_VIEWPORT_PAD_RATIO = 0.15;
// Point-only objects are secondary in zone mode. This cap ensures that an area
// with sparse geometry cannot become another field of markers.
const MAX_FALLBACK_DOTS = 40;

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
   * Marker and zone modes are mutually exclusive to keep the map readable.
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
  const presentation = PARKING_LOD_PRESENTATION[lod];

  // Clustering is fed the FULL, stable `parkings` array — NOT a copy with the
  // selected parking filtered out. That filtered array used to be the input
  // to useClustering's spatial index, and since its signature (ids+positions,
  // see parkingClusterSignature) is different every time a DIFFERENT parking
  // is excluded, Supercluster rebuilt its whole index from scratch — an
  // O(n log n) synchronous scan — on every single tap between zones (the
  // "micro lag switching zones"). The selected parking's own marker is
  // unconditionally rendered separately below regardless of what clustering
  // does with it, so excluding it from the index was never required to keep
  // it visible — only to avoid rendering it a second time as a plain marker,
  // which the render loop below now handles directly (a cheap per-item id
  // check, not an index rebuild). Trade-off: in the rare case where the
  // selected point is still within clustering range (zoom < 13) — e.g.
  // selected via the "nearby parking" card while zoomed out — a cluster near
  // it may count it once more in its bubble; its own pin is unaffected.
  const clusterItems = useClustering(parkings, latitudeDelta, viewportBounds);

  // Zone mode must not reuse Supercluster's output: even at street zoom two
  // adjacent parking segments may still be represented by one cluster item,
  // which would make both geometries disappear while cluster bubbles are
  // hidden. This filter is a plain O(n) array scan (no spatial index to
  // rebuild), so excluding the selected parking here — to avoid drawing its
  // zone outline twice, once here and once via SelectedGeometryLayer below —
  // costs nothing on selection change.
  //
  // Padded like useClustering's VIEWPORT_PAD_RATIO: `viewportBounds` only
  // updates once a pan/zoom gesture SETTLES (onRegionChangeComplete), not
  // continuously while dragging, so a strict (unpadded) bounds check meant
  // zone outlines near the edge would vanish mid-gesture and new ones
  // wouldn't appear until the gesture ended — "zones disappear while I move
  // the map". Keeping a wider ring of zones already mounted absorbs a normal
  // pan/zoom without a visible pop. MAX_ZONE_OUTLINES below still caps the
  // worst case, so this doesn't reopen the render-everything cost the LOD
  // system exists to avoid.
  const zoneParkings = useMemo(() => {
    const latPad = (viewportBounds.north - viewportBounds.south) * ZONE_VIEWPORT_PAD_RATIO;
    const lonPad = (viewportBounds.east  - viewportBounds.west)  * ZONE_VIEWPORT_PAD_RATIO;
    return parkings.filter(p =>
      p.id !== selectedParkingId &&
      p.position.latitude  >= viewportBounds.south - latPad &&
      p.position.latitude  <= viewportBounds.north + latPad &&
      p.position.longitude >= viewportBounds.west  - lonPad &&
      p.position.longitude <= viewportBounds.east  + lonPad,
    );
  }, [parkings, selectedParkingId, viewportBounds]);

  // Supercluster deliberately ignores tag/geometry-only changes. Resolve each
  // individual marker from the canonical array so a refreshed fee or position
  // is visible without rebuilding the whole spatial index.
  const parkingMap = useMemo(
    () => new Map(parkings.map(parking => [parking.id, parking])),
    [parkings],
  );

  const selectedPaid = selectedParking ? isPaidParking(selectedParking.tags) : false;
  const selectedRenderGeometry = selectedParking
    ? parkingRenderGeometry(selectedParking.tags, selectedPolygon, selectedPolyline)
    : null;
  const selectedHasGeometry = Boolean(
    selectedRenderGeometry?.polygon || selectedRenderGeometry?.lines.length,
  );

  return (
    <>
      {/* ── Zone outlines — individual (non-clustered) areas, medium/high LOD ──
       * Solid boundaries (no dashes). Simplified at medium zoom, full at high;
       * skipped entirely at low zoom (markers only). Uses canonical viewport
       * objects instead of cluster output, so nearby street segments cannot
       * disappear merely because their centre points were grouped. The selected
       * zone is drawn separately below. Capped as a safety net.
       */}
      {presentation.showZones && (() => {
        let zoneShown = 0;
        let fallbackShown = 0;
        return zoneParkings.map(p => {
          const hasGeometry = hasPolygonGeometry(p.polygon) || hasPolylineGeometry(p.polyline);

          if (!hasGeometry) {
            if (fallbackShown >= MAX_FALLBACK_DOTS) return null;
            fallbackShown++;
            return (
              <GeometryFallbackMarker
                key={`zone-fallback-${p.id}`}
                parking={p}
                selected={false}
                onPress={onPressMarker}
              />
            );
          }

          if (zoneShown >= MAX_ZONE_OUTLINES) return null;
          zoneShown++;
          return (
            <ZoneOutline
              key={`zone-${p.id}`}
              parking={p}
              simplified={presentation.simplifyZones}
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
      {presentation.showMarkers && (() => {
        let individualShown = 0;
        return clusterItems.map(item => {
          if (item.type === 'cluster') {
            return (
              <ClusterMarker
                key={`${item.id}-${item.count}`}
                item={item}
                onPress={onPressCluster}
              />
            );
          }
          // The selected parking is no longer excluded from clustering's
          // INPUT (see the comment above clusterItems) — skip it here instead
          // so it isn't drawn twice; its own (larger) marker renders below.
          if (item.data.id === selectedParkingId) return null;
          if (individualShown >= MAX_INDIVIDUAL_MARKERS) return null;
          individualShown++;
          const parking = parkingMap.get(item.data.id) ?? item.data;
          const feeKey = isPaidParking(parking.tags) ? 'paid' : 'free';
          return (
            <ParkingMarker
              key={`${parking.id}-${feeKey}`}
              parking={parking}
              isSelected={false}
              onPress={onPressMarker}
            />
          );
        });
      })()}

      {/* ── Selected parking — persistent overlay (Bug 2) ─────────────────────
       * Rendered from the snapshot above the active layer. The selected zone is
       * highlighted in medium/high; at low zoom only its selected P is shown.
       * The selection persists through pan, zoom, rotate and tilt.
       */}
      {selectedParking && presentation.showZones && (
        <SelectedGeometryLayer
          // Key by the selected id so switching selection REMOUNTS the whole
          // geometry subtree — this forces the old native Polygon/Polyline to
          // unmount (react-native-maps/Google can otherwise leave a removed
          // polygon on screen), fixing "the old zone doesn't always disappear".
          key={`sel-geom-${selectedParking.id}`}
          parking={selectedParking}
          polygon={selectedPolygon}
          polyline={selectedPolyline}
          visible
          paid={selectedPaid}
        />
      )}
      {selectedParking && presentation.showZones &&
        !selectedHasGeometry && (
        <GeometryFallbackMarker
          key={`selected-zone-fallback-${selectedParking.id}`}
          parking={selectedParking}
          selected
          onPress={onPressMarker}
        />
      )}
      {selectedParking && presentation.showMarkers && (
        <ParkingMarker
          // Stable key — deliberately NOT including selectedParking.id.
          // Keying by id used to remount this marker (unmount+mount native
          // views) on EVERY switch between zones, which was a real chunk of
          // the "micro lag between zones": ParkingMarker's own custom memo
          // comparator already re-renders correctly when the underlying
          // parking/id changes, and its tracksViewChanges effect now re-warms
          // on that same change so the native raster still catches the
          // resulting size/colour update. Unlike SelectedGeometryLayer below,
          // a Marker's content/coordinate updating in place is well-supported
          // by react-native-maps — there's no equivalent "stale native view"
          // bug here to work around.
          key="selected-parking"
          parking={selectedParking}
          isSelected
          onPress={onPressMarker}
        />
      )}
    </>
  );
});
ParkingLayer.displayName = 'ParkingLayer';

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
  fallbackHitArea: {
    width: 22,
    height: 22,
    borderRadius: 11,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  fallbackHitAreaSelected: {
    backgroundColor: 'rgba(255,255,255,0.92)',
    borderWidth: 1,
    borderColor: PARKING_ACCENT,
  },
  fallbackDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: 'rgba(71,85,105,0.72)',
  },
  fallbackDotSelected: {
    width: 9,
    height: 9,
    borderRadius: 4.5,
    backgroundColor: PARKING_ACCENT,
  },
});
