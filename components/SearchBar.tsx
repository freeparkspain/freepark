import React, { useCallback, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import MapView, { Region } from "react-native-maps";

// Photon (komoot) — OSM-based, no API key, no User-Agent requirement.
// Coordinates are GeoJSON order: [longitude, latitude].
interface PhotonFeature {
  geometry: { coordinates: [number, number] };
  properties: {
    osm_id: number;
    name?: string;
    street?: string;
    housenumber?: string;
    district?: string;
    city?: string;
    state?: string;
    country?: string;
  };
}

interface PhotonResponse {
  features: PhotonFeature[];
}

// Internal shape used throughout the component.
interface SearchResult {
  key: string;
  displayName: string;
  latitude: number;
  longitude: number;
}

interface SearchBarProps {
  mapRef: React.RefObject<MapView | null>;
  onLocationSelect?: (
    latitude: number,
    longitude: number,
    addr?: string,
  ) => void;
  onClear?: () => void;
}

// lat/lon bias toward Málaga city centre — Photon returns closest results first.
const PHOTON_URL =
  "https://photon.komoot.io/api/?limit=5&lat=36.7213&lon=-4.4214";

function buildDisplayName(p: PhotonFeature["properties"]): string {
  // Формируем строку: "Улица Номер, Район, Город"
  const streetAndNumber = p.housenumber
    ? `${p.street ?? ""} ${p.housenumber}`.trim()
    : p.street;

  const parts: (string | undefined)[] = [
    // Если есть название (н-р "Кафе"), и оно не совпадает с улицей — пишем его
    p.name !== p.street ? p.name : undefined,
    streetAndNumber,
    p.district,
    p.city,
  ];
  return parts.filter(Boolean).join(", ");
}

function toResults(features: PhotonFeature[]): SearchResult[] {
  return features.map((f) => ({
    key: String(f.properties.osm_id),
    displayName: buildDisplayName(f.properties),
    latitude: f.geometry.coordinates[1],
    longitude: f.geometry.coordinates[0],
  }));
}

export const SearchBar: React.FC<SearchBarProps> = ({
  mapRef,
  onLocationSelect,
  onClear,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const fetchResults = useCallback(
    async (text: string): Promise<SearchResult[]> => {
      if (text.trim().length < 3) {
        setResults([]);
        return [];
      }
      setLoading(true);
      setError(null);
      try {
        const url = `${PHOTON_URL}&q=${encodeURIComponent(text)}`;
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: PhotonResponse = await response.json();
        const parsed = toResults(data.features);
        setResults(parsed);
        return parsed;
      } catch (err) {
        console.warn("[SearchBar] fetch failed:", err);
        setError("Could not load results. Try again.");
        setResults([]);
        return [];
      } finally {
        setLoading(false);
      }
    },
    [],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      if (text.trim().length === 0) {
        setResults([]);
        setError(null);
        return;
      }
      debounceTimer.current = setTimeout(() => fetchResults(text), 500);
    },
    [fetchResults],
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      const region: Region = {
        latitude: result.latitude,
        longitude: result.longitude,
        latitudeDelta: 0.005,
        longitudeDelta: 0.005,
      };
      mapRef.current?.animateToRegion(region, 800);
      onLocationSelect?.(result.latitude, result.longitude, result.displayName);
      setQuery(result.displayName);
      setResults([]);
      Keyboard.dismiss();
    },
    [mapRef, onLocationSelect],
  );

  // Unified trigger: suggestion tap / Return key / search icon tap.
  const handleSubmit = useCallback(async () => {
    const first =
      results.length > 0 ? results[0] : (await fetchResults(query))[0];
    if (first) handleSelect(first);
  }, [results, query, fetchResults, handleSelect]);

  const handleClear = useCallback(() => {
    setQuery("");
    setResults([]);
    setError(null);
    onClear?.();
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    Keyboard.dismiss();
  }, [onClear]);

  return (
    // flex-1 — parent (MapScreen header row) controls position and width
    <View className="flex-1">
      <View className="flex-row items-center bg-white rounded-full px-4 py-2.5 shadow-md">
        <TouchableOpacity
          onPress={handleSubmit}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
        >
          <Text className="text-base mr-2">🔍</Text>
        </TouchableOpacity>
        <TextInput
          className="flex-1 text-sm text-gray-800"
          placeholder="Search address..."
          placeholderTextColor="#9CA3AF"
          value={query}
          onChangeText={handleChangeText}
          returnKeyType="search"
          onSubmitEditing={handleSubmit}
          autoCorrect={false}
          autoCapitalize="none"
        />
        {loading && (
          <ActivityIndicator
            size="small"
            color="#3B82F6"
            style={{ marginLeft: 8 }}
          />
        )}
        {!loading && query.length > 0 && (
          <TouchableOpacity
            onPress={handleClear}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text className="text-gray-400 text-base ml-2">✕</Text>
          </TouchableOpacity>
        )}
      </View>

      {error !== null && (
        <View className="bg-white mt-1 rounded-2xl px-4 py-3 shadow-md">
          <Text className="text-xs text-red-500">{error}</Text>
        </View>
      )}

      {results.length > 0 && (
        <View className="bg-white mt-1 rounded-2xl shadow-md overflow-hidden">
          {results.map((item, index) => (
            <TouchableOpacity
              key={item.key}
              onPress={() => handleSelect(item)}
              activeOpacity={0.7}
              className={`px-4 py-3${index < results.length - 1 ? " border-b border-gray-100" : ""}`}
            >
              <Text className="text-xs text-gray-800" numberOfLines={2}>
                {item.displayName}
              </Text>
            </TouchableOpacity>
          ))}
        </View>
      )}
    </View>
  );
};
