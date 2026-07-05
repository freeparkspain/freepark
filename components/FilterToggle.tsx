import React from "react";
import { TouchableOpacity, Text, View } from "react-native";
import { useParkingStore } from "../store/useParkingStore";

interface Props {
  /** Number of parking spots currently visible under the active filter. */
  count?: number;
}

// Compact free/paid toggle shown to the right of the search bar.
// Drives the OSM parking layer's visibility (see MapScreen `visibleParkings`).
// No absolute positioning — parent (MapScreen header row) controls placement.
export const FilterToggle: React.FC<Props> = ({ count }) => {
  const filterOnlyFree     = useParkingStore((s) => s.filterOnlyFree);
  const toggleFilterOnlyFree = useParkingStore((s) => s.toggleFilterOnlyFree);

  return (
    <TouchableOpacity
      onPress={toggleFilterOnlyFree}
      activeOpacity={0.85}
      className={`flex-row items-center gap-2 rounded-full px-4 py-2.5 shadow-md ${
        filterOnlyFree ? "bg-blue-500" : "bg-white"
      }`}
    >
      <Text
        className={`text-sm font-semibold ${
          filterOnlyFree ? "text-white" : "text-gray-700"
        }`}
      >
        {filterOnlyFree ? "Free Only" : "All Parking"}
      </Text>
      {count !== undefined && (
        <View
          className={`rounded-full px-2 py-0.5 ${
            filterOnlyFree ? "bg-blue-400" : "bg-gray-100"
          }`}
        >
          <Text
            className={`text-xs font-bold ${
              filterOnlyFree ? "text-white" : "text-gray-600"
            }`}
          >
            {count}
          </Text>
        </View>
      )}
    </TouchableOpacity>
  );
};
