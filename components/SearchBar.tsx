import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  ActivityIndicator,
  Keyboard,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from "react-native";
import { AppIcon } from "./AppIcon";
import {
  LatestSearchRequest,
  SearchResult,
  parsePhotonResponse,
} from "../utils/photon";

// Photon (komoot) — OSM-based, no API key, no User-Agent requirement.
// Coordinates are GeoJSON order: [longitude, latitude].
interface SearchBarProps {
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

export const SearchBar: React.FC<SearchBarProps> = ({
  onLocationSelect,
  onClear,
}) => {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<SearchResult[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const latestRequest = useRef(new LatestSearchRequest()).current;

  useEffect(() => () => {
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    latestRequest.invalidate();
  }, [latestRequest]);

  const fetchResults = useCallback(
    async (text: string): Promise<SearchResult[]> => {
      if (text.trim().length < 3) {
        setResults([]);
        return [];
      }
      const { requestId, controller } = latestRequest.start();
      setLoading(true);
      setError(null);
      try {
        const url = `${PHOTON_URL}&q=${encodeURIComponent(text)}`;
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data: unknown = await response.json();
        const parsed = parsePhotonResponse(data);
        if (!latestRequest.isCurrent(requestId)) return [];
        setResults(parsed);
        return parsed;
      } catch (err) {
        if (!latestRequest.isCurrent(requestId)) return [];
        console.warn("[SearchBar] fetch failed:", err);
        setError("Could not load results. Try again.");
        setResults([]);
        return [];
      } finally {
        if (latestRequest.isCurrent(requestId)) {
          latestRequest.finish(requestId);
          setLoading(false);
        }
      }
    },
    [latestRequest],
  );

  const handleChangeText = useCallback(
    (text: string) => {
      setQuery(text);
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      latestRequest.invalidate();
      setLoading(false);
      setResults([]);
      if (text.trim().length < 3) {
        if (text.trim().length === 0) setError(null);
        return;
      }
      debounceTimer.current = setTimeout(() => { void fetchResults(text); }, 500);
    },
    [fetchResults, latestRequest],
  );

  const handleSelect = useCallback(
    (result: SearchResult) => {
      if (debounceTimer.current) clearTimeout(debounceTimer.current);
      latestRequest.invalidate();
      setLoading(false);
      // The camera move to the selected result lives in MapScreen's
      // onLocationSelect — it used to ALSO happen here (a second
      // animateToRegion on the same mapRef, to a slightly different zoom
      // level, fired in the same tick), which raced the two animations
      // against each other and made every search selection visibly jerk.
      onLocationSelect?.(result.latitude, result.longitude, result.displayName);
      setQuery(result.displayName);
      setResults([]);
      Keyboard.dismiss();
    },
    [latestRequest, onLocationSelect],
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
    setLoading(false);
    onClear?.();
    if (debounceTimer.current) clearTimeout(debounceTimer.current);
    latestRequest.invalidate();
    Keyboard.dismiss();
  }, [latestRequest, onClear]);

  return (
    // flex-1 — parent (MapScreen header row) controls position and width
    <View className="flex-1">
      <View className="flex-row items-center bg-white rounded-full px-4 py-2.5 shadow-md">
        <TouchableOpacity
          onPress={handleSubmit}
          hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          accessibilityRole="button"
          accessibilityLabel="Search destination"
        >
          <AppIcon
            name="search-outline"
            size={20}
            color="#334155"
            style={{ marginRight: 8 }}
          />
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
            accessibilityRole="button"
            accessibilityLabel="Clear search"
          >
            <AppIcon
              name="close-circle-outline"
              size={20}
              color="#94A3B8"
              style={{ marginLeft: 8 }}
            />
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
