import React from 'react';
import { View, Text } from 'react-native';

interface LegendItem {
  color: string;
  label: string;
}

const LEGEND_ITEMS: LegendItem[] = [
  { color: '#3B82F6', label: 'Free' },
  { color: '#EF4444', label: 'Paid' },
  { color: '#6B7280', label: 'Unknown' },
];

export const MapLegend: React.FC = () => (
  <View className="absolute bottom-24 left-4 bg-white rounded-2xl shadow-md px-3 py-2.5 gap-1.5">
    {LEGEND_ITEMS.map(({ color, label }) => (
      <View key={label} className="flex-row items-center gap-2">
        <View style={{ backgroundColor: color }} className="w-3 h-3 rounded-full" />
        <Text className="text-xs font-medium text-gray-700">{label}</Text>
      </View>
    ))}
  </View>
);
