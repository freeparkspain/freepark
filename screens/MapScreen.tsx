import React, { useCallback, useRef } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import MapView, { UrlTile, PROVIDER_DEFAULT } from 'react-native-maps';
import { useNavigation } from '@react-navigation/native';
import { NativeStackNavigationProp } from '@react-navigation/native-stack';
import { ParkingMarker } from '../components/ParkingMarker';
import { FilterToggle } from '../components/FilterToggle';
import { MapLegend } from '../components/MapLegend';
import { useParkingStore, useFilteredSpots } from '../store/useParkingStore';
import { ParkingSpot, RootStackParamList } from '../types/parking';

type MapNav = NativeStackNavigationProp<RootStackParamList, 'Map'>;

export const MALAGA_REGION = {
  latitude: 36.7213,
  longitude: -4.4214,
  latitudeDelta: 0.09,
  longitudeDelta: 0.06,
};

export const MapScreen: React.FC = () => {
  const navigation = useNavigation<MapNav>();
  const { setSelectedSpot } = useParkingStore();
  const filteredSpots = useFilteredSpots();
  const mapRef = useRef<MapView>(null);

  const handleMarkerPress = useCallback(
    (spot: ParkingSpot) => {
      setSelectedSpot(spot);
      navigation.navigate('ParkingDetails', { spotId: spot.id });
    },
    [navigation, setSelectedSpot],
  );

  const handleRecenter = useCallback(() => {
    mapRef.current?.animateToRegion(MALAGA_REGION, 800);
  }, []);

  return (
    <View style={styles.container}>
      <MapView
        ref={mapRef}
        style={styles.map}
        provider={PROVIDER_DEFAULT}
        initialRegion={MALAGA_REGION}
        mapType="none"
        showsUserLocation
        showsMyLocationButton={false}
      >
        <UrlTile
          urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maximumZ={19}
          flipY={false}
          zIndex={-1}
        />
        {filteredSpots.map((spot) => (
          <ParkingMarker key={spot.id} spot={spot} onPress={handleMarkerPress} />
        ))}
      </MapView>

      {/* Filter toggle — top right */}
      <FilterToggle />

      {/* Colour legend — bottom left */}
      <MapLegend />

      {/* Recenter button — bottom right */}
      <View className="absolute bottom-8 right-4">
        <TouchableOpacity
          onPress={handleRecenter}
          activeOpacity={0.85}
          className="bg-white w-12 h-12 rounded-full items-center justify-center shadow-md"
        >
          <Text className="text-xl">📍</Text>
        </TouchableOpacity>
      </View>
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
});
