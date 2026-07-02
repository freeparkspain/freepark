import React, { memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker, Polygon, Polyline } from 'react-native-maps';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { useClustering, ClusterItem } from '../hooks/useClustering';
import { ParkingMarker } from './ParkingMarker';

// ─── Geometry styles ──────────────────────────────────────────────────────────

const POLY = { fill: 'rgba(0,122,255,0.30)', stroke: '#007AFF', width: 2.5 };
const LINE = { color: '#007AFF', width: 8 };

// ─── SelectedGeometryLayer ────────────────────────────────────────────────────
// Isolated into its own memo'd component so that polygon load / unload events
// (which change `polygon` / `polyline` frequently) never trigger a reconcile
// of the markers loop below.  The two subtrees are now fully decoupled.

interface GeometryLayerProps {
  selectedParkingId: string | null;
  polygon:           LatLng[] | null;
  polyline:          LatLng[] | null;
}

const SelectedGeometryLayer = memo(({
  selectedParkingId,
  polygon,
  polyline,
}: GeometryLayerProps) => (
  <>
    {polygon && selectedParkingId && (
      <Polygon
        key={`poly-${selectedParkingId}`}
        coordinates={polygon}
        fillColor={POLY.fill}
        strokeColor={POLY.stroke}
        strokeWidth={POLY.width}
        zIndex={2}
      />
    )}
    {polyline && !polygon && selectedParkingId && (
      <Polyline
        key={`line-${selectedParkingId}`}
        coordinates={polyline}
        strokeColor={LINE.color}
        strokeWidth={LINE.width}
        lineCap="round"
        lineJoin="round"
        zIndex={2}
      />
    )}
  </>
));

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
});

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
}: Props) => {

  const clusterItems = useClustering(parkings, latitudeDelta, viewportBounds);

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
      />

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
    backgroundColor: '#007AFF',
    borderWidth:     2.5,
    borderColor:     '#ffffff',
    justifyContent:  'center',
    alignItems:      'center',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.30,
    shadowRadius:    4,
    elevation:       8,
  },
  clusterText: { color: '#ffffff', fontWeight: '800' },
});
