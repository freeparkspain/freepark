import React, { memo, useEffect, useState } from 'react';
import { Animated, View, StyleSheet, Platform } from 'react-native';
import { MarkerAnimated as RNMarkerAnimated, AnimatedRegion } from 'react-native-maps';

// react-native-maps' animated marker doesn't type-check as a JSX element under
// React 19's stricter types — isolate that unavoidable library gap here.
const MarkerAnimated = RNMarkerAnimated as unknown as React.ComponentType<any>;

interface Props {
  /** AnimatedRegion driving the arrow's coordinate (smooth movement). */
  coordinate: AnimatedRegion;
  /** Animated.Value of the map-relative bearing in degrees (smooth rotation). */
  rotation:   Animated.Value;
}

const ACCENT = '#2563EB';

// Premium top-down navigation puck drawn from Views (a vector asset — not an
// emoji, not a system pin, no runtime download): a soft glow, a white disc with
// a subtle accent rim, and an accent arrowhead pointing UP at rotation 0
// (0° = north). Only the marker's single `rotation` expresses heading — no child
// rotation — so the angle is never doubled, and it stays crisp over any basemap.
const ArrowGlyph = memo(() => (
  <View style={styles.container}>
    <View style={styles.glow} />
    <View style={styles.disc}>
      <View style={styles.arrowHead} />
    </View>
  </View>
));

function NavigationArrowBase({ coordinate, rotation }: Props) {
  // Warm the raster once (so the View commits at the right size), then freeze —
  // prevents Android bitmap caching from freezing a 0×0 frame, and keeps
  // zoom/pan smooth since the glyph never changes afterwards.
  const [tracks, setTracks] = useState(true);
  useEffect(() => {
    const t = setTimeout(() => setTracks(false), 400);
    return () => clearTimeout(t);
  }, []);

  return (
    <MarkerAnimated
      coordinate={coordinate as unknown as { latitude: number; longitude: number }}
      anchor={{ x: 0.5, y: 0.5 }}
      flat
      rotation={rotation as unknown as number}
      tracksViewChanges={tracks}
      zIndex={100}
    >
      <ArrowGlyph />
    </MarkerAnimated>
  );
}

export const NavigationArrow = memo(NavigationArrowBase);

const styles = StyleSheet.create({
  container: {
    width: 36,
    height: 40,
    alignItems: 'center',
    justifyContent: 'center',
    // Soft drop shadow on iOS; Android depth comes from the rounded glow below
    // (elevation on a triangle would draw a gray square).
    ...Platform.select({
      ios: {
        shadowColor: '#0F172A',
        shadowOffset: { width: 0, height: 2 },
        shadowOpacity: 0.28,
        shadowRadius: 4,
      },
      default: {},
    }),
  },
  glow: {
    position: 'absolute',
    width: 36,
    height: 36,
    borderRadius: 18,
    backgroundColor: 'rgba(37, 99, 235, 0.16)',
    elevation: Platform.OS === 'android' ? 4 : 0,
  },
  // White disc "puck" body with a subtle accent rim.
  disc: {
    width: 28,
    height: 28,
    borderRadius: 14,
    backgroundColor: '#FFFFFF',
    borderWidth: 2,
    borderColor: 'rgba(37, 99, 235, 0.22)',
    alignItems: 'center',
    justifyContent: 'center',
  },
  // Accent arrowhead centered in the disc, pointing up.
  arrowHead: {
    width: 0,
    height: 0,
    marginTop: -1,
    borderLeftWidth: 7,
    borderRightWidth: 7,
    borderBottomWidth: 14,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: ACCENT,
  },
});
