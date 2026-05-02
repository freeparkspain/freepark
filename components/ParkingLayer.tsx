import React, { memo } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker, Polygon, Polyline } from 'react-native-maps';
import { OsmParking, LatLng, BBox } from '../types/parking';
import { useClustering, ClusterItem } from '../hooks/useClustering';
import { ParkingMarker } from './ParkingMarker';

// ─── Geometry styles ──────────────────────────────────────────────────────────
// Mapy.com spec: fill = rgba(0, 122, 255, 0.3)

const POLY = { fill: 'rgba(0,122,255,0.30)', stroke: '#007AFF', width: 2.5 };
const LINE = { color: '#007AFF', width: 8 };

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
  parkings:         OsmParking[];
  selectedParking:  OsmParking | null;
  latitudeDelta:    number;
  viewportBounds:   BBox;
  onPressMarker:    (parking: OsmParking) => void;
  onPressCluster:   (position: LatLng) => void;
  // Lazily-loaded geometry for the selected parking (null while loading or for nodes)
  selectedPolygon:  LatLng[] | null;
  selectedPolyline: LatLng[] | null;
  geometryLoading:  boolean;
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
  geometryLoading,
}: Props) => {

  const clusterItems = useClustering(parkings, latitudeDelta, viewportBounds);
  const selectedId   = selectedParking?.id ?? null;

  return (
    <>
      {/*
       * ── Lazily-loaded geometry (Mapy.com effect) ──────────────────────────
       *
       * Geometry arrives via a dedicated second request fired on tap, not from
       * the main markers fetch. selectedPolygon / selectedPolyline come from
       * useGeometryLoader in MapScreen and are null until that request resolves.
       *
       * While loading: the selected ParkingMarker shows a spinner (below).
       * Once loaded:   the overlay appears and the spinner reverts to 'P'.
       */}
      {selectedPolygon && selectedParking && (
        <Polygon
          key={`poly-${selectedParking.id}`}
          coordinates={selectedPolygon}
          fillColor={POLY.fill}
          strokeColor={POLY.stroke}
          strokeWidth={POLY.width}
          zIndex={2}
        />
      )}
      {selectedPolyline && !selectedPolygon && selectedParking && (
        <Polyline
          key={`line-${selectedParking.id}`}
          coordinates={selectedPolyline}
          strokeColor={LINE.color}
          strokeWidth={LINE.width}
          lineCap="round"
          lineJoin="round"
          zIndex={2}
        />
      )}

      {/* ── Markers / clusters ──────────────────────────────────────────────── */}
      {clusterItems.map(item =>
        item.type === 'cluster' ? (
          <ClusterMarker key={item.id} item={item} onPress={onPressCluster} />
        ) : (
          <ParkingMarker
            key={item.data.id}
            parking={item.data}
            isSelected={item.data.id === selectedId}
            isLoadingGeometry={item.data.id === selectedId && geometryLoading}
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
