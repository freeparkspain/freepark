import React, { memo, useEffect, useState } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Marker } from 'react-native-maps';
import { OsmParking } from '../types/parking';

// Single shared "parking" accent — badge, zone lines, filled zone and cluster
// bubbles all draw from the same family, so the whole layer reads as one
// consistent visual language instead of a patchwork of one-off colours.
export const PARKING_ACCENT      = '#007AFF';
export const PARKING_ACCENT_DEEP = '#0A5FD6'; // selected-state shade — same hue, deeper

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
  // After 150 ms the flag drops to false — enough for the native layer to
  // commit the initial raster before it freezes into a static GPU bitmap.
  // 500 ms kept many markers "warm" simultaneously during zoom-driven
  // burst-mounts, causing sustained GPU re-rasterisation and dropped frames;
  // 150 ms is tight enough to avoid the 0×0 glitch and short enough to
  // release the GPU pressure well before the next gesture arrives.
  const [tracksViews, setTracksViews] = useState(true);

  useEffect(() => {
    const timer = setTimeout(() => setTracksViews(false), 150);
    return () => clearTimeout(timer);
  }, []);

  return (
    <Marker
      coordinate={parking.position}
      tracksViewChanges={tracksViews}
      anchor={{ x: 0.5, y: 0.5 }}
      zIndex={isSelected ? 10 : 1}
      onPress={() => {
        console.log('[ParkingMarker] tapped:', parking.id);
        onPress(parking);
      }}
    >
      <View
        style={[styles.ring, isSelected && styles.ringSelected]}
        renderToHardwareTextureAndroid={Platform.OS === 'android'}
        // @ts-ignore — shouldRasterizeIOS is valid but not typed in RN defs
        shouldRasterizeIOS={Platform.OS === 'ios'}
        collapsable={false}
      >
        <View style={[styles.badge, isSelected && styles.badgeSelected]}>
          {isLoadingGeometry ? (
            <ActivityIndicator size="small" color="#ffffff" />
          ) : (
            <Text style={[styles.glyph, isSelected && styles.glyphSelected]}>P</Text>
          )}
        </View>
      </View>
    </Marker>
  );
}

export const ParkingMarker = memo(ParkingMarkerBase, arePropsEqual);

// Two-tone "badge" pin — a crisp white ring (keeps the marker legible against
// any tile colour beneath it) wrapping a deep-blue disc with a bold glyph.
// Reads cleanly at a glance and scales smoothly into the larger selected state,
// echoing the custom-POI style of modern navigation apps.
const styles = StyleSheet.create({
  ring: {
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: '#ffffff',
    justifyContent:  'center',
    alignItems:      'center',
    shadowColor:     '#0F172A',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.28,
    shadowRadius:    4,
    elevation:       6,
  },
  ringSelected: {
    width:         40,
    height:        40,
    borderRadius:  20,
    shadowOpacity: 0.40,
    shadowRadius:  7,
    elevation:     10,
  },
  badge: {
    width:           24,
    height:          24,
    borderRadius:    12,
    backgroundColor: PARKING_ACCENT,
    justifyContent:  'center',
    alignItems:      'center',
  },
  badgeSelected: {
    width:           30,
    height:          30,
    borderRadius:    15,
    backgroundColor: PARKING_ACCENT_DEEP,
  },
  glyph: {
    color:            '#ffffff',
    fontSize:         13,
    fontWeight:       '800',
    includeFontPadding: false,
    letterSpacing:    -0.5,
  },
  glyphSelected: {
    fontSize: 16,
  },
});
