import React from 'react';
import { View, Text, ScrollView } from 'react-native';
import { RouteProp, useRoute } from '@react-navigation/native';
import { useParkingStore } from '../store/useParkingStore';
import { ParkingType, RootStackParamList } from '../types/parking';
import { AppIcon, AppIconName } from '../components/AppIcon';

type ParkingDetailsRouteProp = RouteProp<RootStackParamList, 'ParkingDetails'>;

const TYPE_LABEL: Record<ParkingType, string> = {
  free:    'Free Parking',
  paid:    'Paid Parking',
  unknown: 'Unknown',
};

const TYPE_BADGE: Record<ParkingType, string> = {
  free:    'bg-blue-500',
  paid:    'bg-red-500',
  unknown: 'bg-gray-500',
};

interface InfoRowProps {
  icon: AppIconName;
  label: string;
  value: string;
}

const InfoRow: React.FC<InfoRowProps> = ({ icon, label, value }) => (
  <View className="flex-row items-start py-3 border-b border-gray-100">
    <AppIcon
      name={icon}
      size={19}
      color="#64748B"
      style={{ marginRight: 12, marginTop: 2 }}
    />
    <View className="flex-1">
      <Text className="text-xs text-gray-400 uppercase tracking-wider mb-0.5">{label}</Text>
      <Text className="text-sm text-gray-800 font-medium leading-5">{value}</Text>
    </View>
  </View>
);

export const ParkingDetailsScreen: React.FC = () => {
  const route = useRoute<ParkingDetailsRouteProp>();
  const { spots } = useParkingStore();
  const spot = spots.find((s) => s.id === route.params.spotId);

  if (!spot) {
    return (
      <View className="flex-1 items-center justify-center bg-white">
        <Text className="text-gray-500 text-base">Spot not found.</Text>
      </View>
    );
  }

  return (
    <ScrollView className="flex-1 bg-white">
      <View className="px-4 pt-6 pb-10">
        {/* Header */}
        <View className="flex-row items-start justify-between mb-3">
          <Text className="text-xl font-bold text-gray-900 flex-1 mr-3 leading-7">
            {spot.name}
          </Text>
          <View className={`rounded-full px-3 py-1 mt-1 ${TYPE_BADGE[spot.type]}`}>
            <Text className="text-white text-xs font-semibold">
              {TYPE_LABEL[spot.type]}
            </Text>
          </View>
        </View>

        <Text className="text-sm text-gray-600 leading-6 mb-5">
          {spot.description}
        </Text>

        {/* Info rows */}
        <View className="bg-gray-50 rounded-2xl px-4 pt-1 pb-2">
          {spot.address && (
            <InfoRow icon="location-outline" label="Address" value={spot.address} />
          )}
          {spot.maxHours != null && (
            <InfoRow
              icon="time-outline"
              label="Max Hours"
              value={`${spot.maxHours} ${spot.maxHours === 1 ? 'hour' : 'hours'}`}
            />
          )}
          {spot.notes && (
            <InfoRow icon="document-text-outline" label="Notes" value={spot.notes} />
          )}
          <InfoRow
            icon="map-outline"
            label="Coordinates"
            value={`${spot.latitude.toFixed(5)}°N, ${Math.abs(spot.longitude).toFixed(5)}°W`}
          />
        </View>
      </View>
    </ScrollView>
  );
};
