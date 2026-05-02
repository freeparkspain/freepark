import React, { memo, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Marker } from 'react-native-maps';
import { OsmParking } from '../types/parking';

interface Props {
  parking:           OsmParking;
  isSelected:        boolean;
  isLoadingGeometry: boolean;
  onPress:           (parking: OsmParking) => void;
}

// ─── Custom comparator ────────────────────────────────────────────────────────
// The only prop that changes the visible native marker is `isSelected`
// (controls zIndex so the pin floats to the front).  All other prop changes
// — new `parking` reference on re-fetch, `isLoadingGeometry` toggling, stable
// `onPress` callback — are intentionally ignored to keep reconciliation O(1)
// per selection event instead of O(n) across the entire visible set.
// `isLoadingGeometry`-driven UI feedback is handled by GeometryLoadingBar.
function arePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.isSelected  === next.isSelected &&
    prev.parking.id  === next.parking.id
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

function ParkingMarkerBase({
  parking, isSelected, isLoadingGeometry, onPress,
}: Props) {
  // ── tracksViewChanges warm-up ─────────────────────────────────────────────
  // Start true so the native layer commits the initial raster (correct size,
  // correct icon) before we freeze it.  Without this, some Android devices
  // rasterise at 0×0 and the marker is invisible or untappable.
  // After 500 ms the flag drops to false and stays there — the pin becomes a
  // static GPU bitmap that never causes layout work during pan/zoom.
  const [tracksViews, setTracksViews] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setTracksViews(false), 500);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Marker
      coordinate={parking.position}
      tracksViewChanges={tracksViews}
      calloutEnabled={false}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={isSelected ? 10 : 1}
      onPress={() => {
        console.log('[ParkingMarker] tapped:', parking.id);
        onPress(parking);
      }}
    >
      <View
        style={[styles.pin, isSelected && styles.pinSelected]}
        renderToHardwareTextureAndroid={Platform.OS === 'android'}
        // @ts-ignore — shouldRasterizeIOS is valid but not typed in RN defs
        shouldRasterizeIOS={Platform.OS === 'ios'}
        collapsable={false}
      >
        {isLoadingGeometry ? (
          <ActivityIndicator size="small" color="#ffffff" />
        ) : (
          <Text style={[styles.label, isSelected && styles.labelSelected]}>P</Text>
        )}
      </View>
    </Marker>
  );
}

export const ParkingMarker = memo(ParkingMarkerBase, arePropsEqual);

const styles = StyleSheet.create({
  pin: {
    width:           28,
    height:          28,
    borderRadius:    5,
    backgroundColor: '#007AFF',
    justifyContent:  'center',
    alignItems:      'center',
    borderWidth:     2,
    borderColor:     '#ffffff',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.30,
    shadowRadius:    4,
    elevation:       6,
  },
  pinSelected: {
    width:         34,
    height:        34,
    shadowOpacity: 0.55,
    shadowRadius:  7,
    elevation:     10,
  },
  label: {
    color:      '#ffffff',
    fontWeight: '800',
    fontSize:   13,
  },
  labelSelected: {
    fontSize: 15,
  },
});
