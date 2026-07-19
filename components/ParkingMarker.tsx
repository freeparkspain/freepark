import React, { memo, useEffect, useState } from 'react';
import { View, Text, StyleSheet, Platform } from 'react-native';
import { Marker } from 'react-native-maps';
import { OsmParking } from '../types/parking';
import { isPaidParking } from '../utils/parking';

// Single shared "parking" accent — badge, zone lines, filled zone and cluster
// bubbles all draw from the same family, so the whole layer reads as one
// consistent visual language instead of a patchwork of one-off colours.
export const PARKING_ACCENT      = '#007AFF';
export const PARKING_ACCENT_DEEP = '#0A5FD6'; // selected-state shade — same hue, deeper

// Paid parking gets its own warm accent so a driver can tell "this one costs
// money" at a glance without reading anything — orange badge + euro glyph.
export const PAID_ACCENT      = '#F97316';
export const PAID_ACCENT_DEEP = '#EA580C';

interface Props {
  parking:    OsmParking;
  isSelected: boolean;
  onPress:    (parking: OsmParking) => void;
}

// ─── Custom comparator ────────────────────────────────────────────────────────
// Fresh OSM data may update a coordinate or fee tag for an existing id. Those
// fields are visible and must invalidate the native marker; unrelated tag or
// geometry churn remains ignored.
function arePropsEqual(prev: Props, next: Props): boolean {
  return (
    prev.isSelected  === next.isSelected &&
    prev.parking.id  === next.parking.id &&
    prev.parking.position.latitude === next.parking.position.latitude &&
    prev.parking.position.longitude === next.parking.position.longitude &&
    isPaidParking(prev.parking.tags) === isPaidParking(next.parking.tags)
  );
}

// ─── Component ────────────────────────────────────────────────────────────────

function ParkingMarkerBase({
  parking, isSelected, onPress,
}: Props) {
  const paid = isPaidParking(parking.tags);

  // ── tracksViewChanges warm-up ─────────────────────────────────────────────
  // Start true so the native layer commits the initial raster (correct size,
  // correct icon) before we freeze it.  Without this, some Android devices
  // rasterise at 0×0 and the marker is invisible or untappable.  150 ms is
  // tight enough to avoid that glitch and short enough to release the GPU
  // pressure well before the next gesture arrives.
  //
  // Re-warms (not just on initial mount) whenever the rendered CONTENT
  // changes size/colour — selection toggling on/off, or a fee-status flip.
  // The "selected" marker slot in ParkingLayer now keeps a STABLE key across
  // selection changes (switching zones used to remount this component
  // entirely — real native view churn on every tap), so this component
  // instance can persist and just re-render with new props; without
  // re-triggering the warm-up here, tracksViewChanges would already be frozen
  // false and the native snapshot would keep showing the OLD (wrong) size.
  // Position changes don't need this: react-native-maps updates a Marker's
  // `coordinate` natively without requiring a fresh raster.
  const [tracksViews, setTracksViews] = useState(true);

  useEffect(() => {
    setTracksViews(true);
    const timer = setTimeout(() => setTracksViews(false), 150);
    return () => clearTimeout(timer);
  }, [parking.id, isSelected, paid]);

  return (
    <Marker
      coordinate={parking.position}
      tracksViewChanges={tracksViews}
      // Anchor + centerOffset both at the geometric centre. The visible pin is
      // centred inside a FIXED, symmetric `wrap` box (see styles), so the view
      // frame react-native-maps snapshots is perfectly square — its centre maps
      // exactly onto the coordinate. Without the fixed wrap, the drop shadow /
      // Android elevation expanded the snapshot asymmetrically (downward),
      // pushing the badge visibly off its real position.
      anchor={{ x: 0.5, y: 0.5 }}
      centerOffset={{ x: 0, y: 0 }}
      zIndex={isSelected ? 10 : 1}
      onPress={() => onPress(parking)}
    >
      <View
        style={styles.wrap}
        renderToHardwareTextureAndroid={Platform.OS === 'android'}
        // @ts-ignore — shouldRasterizeIOS is valid but not typed in RN defs
        shouldRasterizeIOS={Platform.OS === 'ios'}
        collapsable={false}
      >
        <View
          style={[
            styles.ring,
            isSelected && styles.ringSelected,
            paid && styles.ringPaid,
          ]}
        >
          <View
            style={[
              styles.badge,
              isSelected && styles.badgeSelected,
              paid && (isSelected ? styles.badgePaidSelected : styles.badgePaid),
            ]}
          >
            {/* Always the glyph — never a spinner. Loading is shown off-map by
                the top GeometryLoadingBar, so markers never turn into spinners. */}
            <Text style={[styles.glyph, isSelected && styles.glyphSelected]}>
              {paid ? '€' : 'P'}
            </Text>
          </View>
        </View>
      </View>
    </Marker>
  );
}

export const ParkingMarker = memo(ParkingMarkerBase, arePropsEqual);

// Two-tone "badge" pin — a crisp white ring (keeps the marker legible against
// any tile colour beneath it) wrapping a coloured disc with a bold glyph.
// The whole pin is centred inside a fixed transparent `wrap` box so the native
// snapshot stays symmetric and the anchor lands exactly on the coordinate.
const styles = StyleSheet.create({
  wrap: {
    width:          48,
    height:         48,
    alignItems:     'center',
    justifyContent: 'center',
    backgroundColor: 'transparent',
  },
  ring: {
    width:           32,
    height:          32,
    borderRadius:    16,
    backgroundColor: '#ffffff',
    justifyContent:  'center',
    alignItems:      'center',
    // No shadow/elevation: on Android, elevation casts a rectangular shadow
    // matching the view box, which showed up as a gray square behind the pin
    // at some zoom levels. The white ring alone gives enough contrast against
    // the Google basemap. A thin hairline border keeps it crisp on white tiles.
    borderWidth:     StyleSheet.hairlineWidth,
    borderColor:     'rgba(15,23,42,0.18)',
  },
  ringSelected: {
    width:         40,
    height:        40,
    borderRadius:  20,
  },
  // Paid: orange border around the white ring — the at-a-glance "costs money" cue.
  ringPaid: {
    borderWidth: 2,
    borderColor: PAID_ACCENT,
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
  badgePaid:         { backgroundColor: PAID_ACCENT },
  badgePaidSelected: { backgroundColor: PAID_ACCENT_DEEP },
  glyph: {
    color:              '#ffffff',
    fontSize:           13,
    fontWeight:         '800',
    includeFontPadding: false,
    letterSpacing:      -0.5,
  },
  glyphSelected: {
    fontSize: 16,
  },
});
