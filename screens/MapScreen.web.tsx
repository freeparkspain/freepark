import React from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { FilterToggle } from '../components/FilterToggle';

// react-native-maps does not support web. This file is picked up by Metro
// automatically for the web platform instead of MapScreen.tsx.
export const MapScreen: React.FC = () => (
  <View style={styles.container}>
    <View style={styles.notice}>
      <Text style={styles.icon}>🗺️</Text>
      <Text style={styles.title}>Map unavailable on web</Text>
      <Text style={styles.body}>
        react-native-maps only works on iOS and Android.{'\n'}
        Scan the QR code with Expo Go to use the full app.
      </Text>
    </View>
    <FilterToggle />
  </View>
);

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#F3F4F6',
  },
  notice: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 32,
    gap: 12,
  },
  icon: { fontSize: 64 },
  title: { fontSize: 20, fontWeight: '700', color: '#111827', textAlign: 'center' },
  body: { fontSize: 14, color: '#6B7280', textAlign: 'center', lineHeight: 22 },
});
