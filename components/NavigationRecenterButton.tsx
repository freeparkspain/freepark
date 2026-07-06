import React from 'react';
import { TouchableOpacity, View, StyleSheet } from 'react-native';

interface Props {
  onPress: () => void;
  /** Distance from the bottom of the screen (computed from insets + trip bar). */
  bottom:  number;
}

// A floating "recenter" control shown only in free mode. The glyph is a
// View-drawn upward navigation triangle (a vector asset — not an emoji).
export const NavigationRecenterButton: React.FC<Props> = ({ onPress, bottom }) => (
  <View style={[styles.wrap, { bottom }]} pointerEvents="box-none">
    <TouchableOpacity
      style={styles.button}
      onPress={onPress}
      activeOpacity={0.85}
      accessibilityRole="button"
      accessibilityLabel="Center navigation view"
    >
      <View style={styles.glyph} />
    </TouchableOpacity>
  </View>
);

const styles = StyleSheet.create({
  wrap: {
    position: 'absolute',
    right: 16,
    zIndex: 10001,
  },
  button: {
    width: 52,
    height: 52,
    borderRadius: 26,
    backgroundColor: '#ffffff',
    alignItems: 'center',
    justifyContent: 'center',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.25,
    shadowRadius: 6,
    elevation: 8,
  },
  // Upward-pointing navigation triangle via the border trick.
  glyph: {
    width: 0,
    height: 0,
    borderLeftWidth: 10,
    borderRightWidth: 10,
    borderBottomWidth: 18,
    borderLeftColor: 'transparent',
    borderRightColor: 'transparent',
    borderBottomColor: '#0A5FD6',
  },
});
