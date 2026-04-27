import React, { memo } from 'react';
import { View, Text, StyleSheet } from 'react-native';
import { Marker } from 'react-native-maps';
import { ParkingSpot, ParkingType } from '../types/parking';

interface MarkerConfig {
  color: string;
  label: string;
}

const TYPE_CONFIG: Record<ParkingType, MarkerConfig> = {
  free:    { color: '#3B82F6', label: 'F' },
  paid:    { color: '#EF4444', label: 'P' },
  unknown: { color: '#6B7280', label: '?' },
};

interface ParkingMarkerProps {
  spot: ParkingSpot;
  onPress: (spot: ParkingSpot) => void;
}

export const ParkingMarker = memo(({ spot, onPress }: ParkingMarkerProps) => {
  const { color, label } = TYPE_CONFIG[spot.type];

  return (
    <Marker
      coordinate={{ latitude: spot.latitude, longitude: spot.longitude }}
      title={spot.name}
      onPress={() => onPress(spot)}
      tracksViewChanges={false}
    >
      <View style={[styles.pin, { backgroundColor: color }]}>
        <Text style={styles.label}>{label}</Text>
      </View>
    </Marker>
  );
});

const styles = StyleSheet.create({
  pin: {
    width: 34,
    height: 34,
    borderRadius: 17,
    justifyContent: 'center',
    alignItems: 'center',
    borderWidth: 2.5,
    borderColor: '#ffffff',
    shadowColor: '#000',
    shadowOffset: { width: 0, height: 2 },
    shadowOpacity: 0.35,
    shadowRadius: 4,
    elevation: 6,
  },
  label: {
    color: '#ffffff',
    fontWeight: 'bold',
    fontSize: 14,
  },
});
