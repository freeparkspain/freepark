import React, { memo } from 'react';
import { View, Text, ActivityIndicator, StyleSheet, Platform } from 'react-native';
import { Marker } from 'react-native-maps';
import { OsmParking } from '../types/parking';

interface Props {
  parking:           OsmParking;
  isSelected:        boolean;
  isLoadingGeometry: boolean;
  onPress:           (parking: OsmParking) => void;
}

export const ParkingMarker = memo(({
  parking, isSelected, isLoadingGeometry, onPress,
}: Props) => (
  <Marker
    coordinate={parking.position}
    // tracksViewChanges must be true while the content is changing (spinner→P)
    // to let the native layer re-render; false otherwise for 60 fps scrolling
    tracksViewChanges={isLoadingGeometry}
    anchor={{ x: 0.5, y: 0.5 }}
    zIndex={isSelected ? 10 : 1}
    onPress={() => onPress(parking)}
  >
    <View
      style={[styles.pin, isSelected && styles.pinSelected]}
      renderToHardwareTextureAndroid={Platform.OS === 'android'}
      // @ts-ignore — shouldRasterizeIOS is valid but not typed in RN defs
      shouldRasterizeIOS={!isLoadingGeometry && Platform.OS === 'ios'}
      collapsable={false}
    >
      {isLoadingGeometry ? (
        <ActivityIndicator size="small" color="#ffffff" />
      ) : (
        <Text style={[styles.label, isSelected && styles.labelSelected]}>P</Text>
      )}
    </View>
  </Marker>
));

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
