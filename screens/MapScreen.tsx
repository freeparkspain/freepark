// npm install babel-preset-expo --save-dev
import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
  ActivityIndicator,
  Keyboard,
  Platform,
} from "react-native";
import MapView, {
  UrlTile,
  PROVIDER_DEFAULT,
  Marker,
  Callout,
  MapMarker,
  Polyline,
  LongPressEvent,
  Region,
} from "react-native-maps";
import { useNavigation } from "@react-navigation/native";
import { NativeStackNavigationProp } from "@react-navigation/native-stack";
import * as Location from "expo-location";
import MapViewDirections from "react-native-maps-directions";

import { SpotMarker } from "../components/SpotMarker";
import { FilterToggle } from "../components/FilterToggle";
import { MapLegend } from "../components/MapLegend";
import { SearchBar } from "../components/SearchBar";
import { ParkingLayer } from "../components/ParkingLayer";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { GeometryLoadingBar } from "../components/GeometryLoadingBar";
import { RouteBottomSheet } from "../components/RouteBottomSheet";
import { useParkingStore, useFilteredSpots } from "../store/useParkingStore";
import { useMapParkings } from "../hooks/useMapParkings";
import { useGeometryLoader } from "../hooks/useGeometryLoader";
import { OsmParking, LatLng, BBox, RouteInfo, RootStackParamList, SelectedDestination } from "../types/parking";
import { MAPS_APIKEY, NAVIGATION_PROVIDER } from "../constants/maps";
import { fetchOsrmRoute } from "../services/navigation/osrmNavigation";

type MapNav = NativeStackNavigationProp<RootStackParamList, "Map">;

export const MALAGA_REGION = {
  latitude: 36.7213,
  longitude: -4.4214,
  latitudeDelta: 0.09,
  longitudeDelta: 0.06,
};

// Default vertical offset (from the bottom of the screen) for the recenter button.
// Lowered so the button sits near the bottom; it lifts above the keyboard when open.
const RECENTER_BOTTOM_DEFAULT = 40;

function regionToBBox(r: Region): BBox {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

export const MapScreen: React.FC = () => {
  const navigation = useNavigation<MapNav>();
  const { setSelectedSpot } = useParkingStore();
  const filteredSpots = useFilteredSpots();

  // ── OSM parking zone hooks ───────────────────────────────────────────────────
  const { parkings, loading, loadForRegion } = useMapParkings();
  const { geometry, geometryLoading, loadGeometry, clearGeometry } = useGeometryLoader();

  // ── Refs ─────────────────────────────────────────────────────────────────────
  const mapRef              = useRef<MapView | null>(null);
  const droppedMarkerRef    = useRef<MapMarker | null>(null);
  const searchMarkerRef     = useRef<MapMarker | null>(null);
  // Guard: Marker.onPress and MapView.onPress both fire for the same physical tap
  // on iOS. We set this flag inside handlePressParkingZone so handleMapPress can bail.
  const markerJustTappedRef = useRef(false);
  // Prevents multiple rapid taps from queuing simultaneous geometry fetches.
  const isProcessingRef     = useRef(false);
  const regionDebounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const osrmFetchIdRef      = useRef(0);

  // ── Search / long-press pin state ────────────────────────────────────────────
  const [searchPin, setSearchPin] = useState<{
    latitude: number;
    longitude: number;
    address: string;
  } | null>(null);

  const [droppedPin, setDroppedPin] = useState<{
    id: number;
    latitude: number;
    longitude: number;
    address: string;
    loading: boolean;
  } | null>(null);

  // ── OSM parking zone state ────────────────────────────────────────────────────
  const [latDelta,          setLatDelta]          = useState(MALAGA_REGION.latitudeDelta);
  const [viewportBounds,    setViewportBounds]    = useState<BBox>(() => regionToBBox(MALAGA_REGION));
  const [selectedParkingId, setSelectedParkingId] = useState<string | null>(null);
  const [activeRoute,       setActiveRoute]       = useState(false);
  const [routeInfo,         setRouteInfo]         = useState<RouteInfo | null>(null);
  const [routeError,        setRouteError]        = useState<string | null>(null);
  const [osrmPolyline,      setOsrmPolyline]      = useState<LatLng[] | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(null);
  const [userLocation,      setUserLocation]      = useState<LatLng | null>(null);

  // ── Keyboard state ─────────────────────────────────────────────────────────────
  // Tracks the on-screen keyboard height so the recenter button can lift above it.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const canNavigate = NAVIGATION_PROVIDER === 'osrm' || MAPS_APIKEY.length > 0;

  // ── Effects ───────────────────────────────────────────────────────────────────
  // Auto-show callout after dropped pin finishes reverse-geocoding
  useEffect(() => {
    if (droppedPin && !droppedPin.loading) {
      const t = setTimeout(() => droppedMarkerRef.current?.showCallout(), 400);
      return () => clearTimeout(t);
    }
  }, [droppedPin?.id, droppedPin?.loading]);

  // Auto-show callout for search result pin
  useEffect(() => {
    if (searchPin) {
      const t = setTimeout(() => searchMarkerRef.current?.showCallout(), 500);
      return () => clearTimeout(t);
    }
  }, [searchPin]);

  // Location permission + live tracking for routing distance calculation
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (loc) =>
          setUserLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude }),
      );
    })();
    return () => { sub?.remove(); };
  }, []);

  // Trigger initial OSM parking zone load (onRegionChangeComplete may not fire on first render)
  useEffect(() => {
    loadForRegion(MALAGA_REGION);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Debounce timer cleanup
  useEffect(() => {
    return () => {
      if (regionDebounceTimer.current) clearTimeout(regionDebounceTimer.current);
    };
  }, []);

  // Keyboard listeners: lift the recenter button above the keyboard while it is open,
  // and return it to its default lower position when the keyboard is dismissed.
  useEffect(() => {
    const showEvent = Platform.OS === "ios" ? "keyboardWillShow" : "keyboardDidShow";
    const hideEvent = Platform.OS === "ios" ? "keyboardWillHide" : "keyboardDidHide";

    const showSub = Keyboard.addListener(showEvent, (e) =>
      setKeyboardHeight(e.endCoordinates?.height ?? 0),
    );
    const hideSub = Keyboard.addListener(hideEvent, () => setKeyboardHeight(0));

    return () => {
      showSub.remove();
      hideSub.remove();
    };
  }, []);

  // ── Map event handlers ────────────────────────────────────────────────────────
  // Debounced: updates viewport state and triggers OSM zone fetch on pan/zoom
  const handleRegionChangeComplete = useCallback((region: Region) => {
    if (regionDebounceTimer.current) clearTimeout(regionDebounceTimer.current);
    regionDebounceTimer.current = setTimeout(() => {
      setLatDelta(region.latitudeDelta);
      setViewportBounds(regionToBBox(region));
      loadForRegion(region);
    }, 500);
  }, [loadForRegion]);

  // Map tap: clears search/dropped pins AND deselects any OSM parking zone.
  // markerJustTappedRef guard prevents iOS double-fire (Marker.onPress + MapView.onPress).
  const handleMapPress = useCallback(() => {
    if (markerJustTappedRef.current) return;
    setDroppedPin(null);
    setSearchPin(null);
    setSelectedDestination(null);
    setSelectedParkingId(null);
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    clearGeometry();
  }, [clearGeometry]);

  // Long-press: drops a pin, sets it as navigation destination, reverse-geocodes address
  const handleLongPress = useCallback(async (e: LongPressEvent) => {
    setSearchPin(null);
    setSelectedParkingId(null);
    clearGeometry();

    const { latitude, longitude } = e.nativeEvent.coordinate;
    const newId    = Date.now();
    const pinId    = `pin-${newId}`;
    const position = { latitude, longitude };
    const coordTitle = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

    console.log('[MapScreen] long-press pin placed at:', coordTitle);

    setDroppedPin({ id: newId, latitude, longitude, loading: true, address: 'Searching…' });
    setSelectedDestination({ id: pinId, type: 'pin', title: coordTitle, position });
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);

    console.log('[MapScreen] selectedDestination set (pin):', coordTitle);
    console.log('[MapScreen] navigation sheet opening for dropped pin');

    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
      const addr = place
        ? `${place.street || ''} ${place.streetNumber || ''}`.trim() || coordTitle
        : coordTitle;
      setDroppedPin((prev) =>
        prev?.id === newId ? { ...prev, address: addr, loading: false } : prev,
      );
      setSelectedDestination((prev) =>
        prev?.id === pinId ? { ...prev, title: addr } : prev,
      );
      console.log('[MapScreen] long-press pin geocoded:', addr);
    } catch {
      setDroppedPin((prev) =>
        prev?.id === newId ? { ...prev, address: coordTitle, loading: false } : prev,
      );
    }
  }, [clearGeometry]);

  // Search result selected: places a pin, sets navigation destination, animates camera
  const handleLocationSelect = useCallback(
    (lat: number, lon: number, addr?: string) => {
      const title = addr || 'Selected Point';
      console.log('[MapScreen] search result selected:', title);

      setDroppedPin(null);
      setSearchPin({ latitude: lat, longitude: lon, address: title });
      setSelectedParkingId(null);
      setSelectedDestination({
        id:       `search-${lat}-${lon}`,
        type:     'search',
        title,
        position: { latitude: lat, longitude: lon },
      });
      setActiveRoute(false);
      setRouteInfo(null);
      setRouteError(null);
      setOsrmPolyline(null);
      clearGeometry();
      mapRef.current?.animateToRegion(
        { latitude: lat, longitude: lon, latitudeDelta: 0.003, longitudeDelta: 0.003 },
        800,
      );

      console.log('[MapScreen] selectedDestination set (search):', title);
      console.log('[MapScreen] navigation sheet opening for search result');
    },
    [clearGeometry],
  );

  // OSM parking zone marker tapped: triggers geometry fetch and bottom sheet
  const handlePressParkingZone = useCallback((parking: OsmParking) => {
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setTimeout(() => { isProcessingRef.current = false; }, 300);

    markerJustTappedRef.current = true;
    requestAnimationFrame(() => { markerJustTappedRef.current = false; });

    console.log('[MapScreen] parking marker tapped:', parking.id);

    const dest: SelectedDestination = {
      id:       parking.id,
      type:     'parking',
      title:    parking.tags.name ?? parking.tags['name:en'] ?? parking.tags['name:ru'] ?? 'Parking',
      position: parking.position,
    };
    setSelectedParkingId(parking.id);
    setSelectedDestination(dest);
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    loadGeometry(parking);

    console.log('[MapScreen] selectedDestination set (parking):', dest.title);
    console.log('[MapScreen] navigation sheet opening for parking:', dest.title);
  }, [loadGeometry]);

  // Cluster tapped: zoom in to break the cluster apart
  const handlePressCluster = useCallback((position: LatLng) => {
    const span = viewportBounds.north - viewportBounds.south;
    mapRef.current?.animateToRegion(
      {
        latitude:       position.latitude,
        longitude:      position.longitude,
        latitudeDelta:  span * 0.5,
        longitudeDelta: (viewportBounds.east - viewportBounds.west) * 0.5,
      },
      400,
    );
  }, [viewportBounds]);

  // ── Bottom sheet handlers ─────────────────────────────────────────────────────
  const handleStartRoute = useCallback(() => {
    if (!selectedDestination) return;
    console.log('[MapScreen] Start Route pressed for:', selectedDestination.title);
    setActiveRoute(true);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    if (NAVIGATION_PROVIDER !== 'osrm' || !userLocation) return;
    const fetchId = ++osrmFetchIdRef.current;
    console.log('[MapScreen] starting OSRM route fetch...');
    fetchOsrmRoute(userLocation, selectedDestination.position)
      .then((r) => {
        if (osrmFetchIdRef.current !== fetchId) return;
        console.log('[MapScreen] route ready:', r.routeInfo.distance.toFixed(1), 'km,', r.routeInfo.duration.toFixed(0), 'min');
        setOsrmPolyline(r.polyline);
        setRouteInfo(r.routeInfo);
      })
      .catch((e) => {
        if (osrmFetchIdRef.current !== fetchId) return;
        const msg = e instanceof Error ? e.message : 'Route unavailable';
        console.warn('[MapScreen] route failed:', msg);
        setRouteError(msg);
      });
  }, [userLocation, selectedDestination]);
  const handleCancelRoute = useCallback(() => {
    osrmFetchIdRef.current++;
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
  }, []);
  const handleCloseSheet = useCallback(() => {
    osrmFetchIdRef.current++;
    setSelectedDestination(null);
    setSelectedParkingId(null);
    setSearchPin(null);
    setDroppedPin(null);
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    clearGeometry();
  }, [clearGeometry]);

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
        onLongPress={handleLongPress}
        onPress={handleMapPress}
        onRegionChangeComplete={handleRegionChangeComplete}
        mapPadding={{ top: 120, right: 0, bottom: 0, left: 0 }}
      >
        <UrlTile
          urlTemplate="https://openstreetmap.org{z}/{x}/{y}.png"
          zIndex={-1}
        />

        {/* JSON parking spots from local data (filtered by free/all toggle) */}
        {filteredSpots.map((spot) => (
          <SpotMarker
            key={spot.id}
            spot={spot}
            onPress={(s) => {
              setSelectedSpot(s);
              navigation.navigate("ParkingDetails", { spotId: s.id });
            }}
          />
        ))}

        {/* OSM parking zones fetched from Overpass API — clusters + polygons */}
        <ParkingLayer
          parkings={parkings}
          selectedParkingId={selectedParkingId}
          latitudeDelta={latDelta}
          viewportBounds={viewportBounds}
          onPressMarker={handlePressParkingZone}
          onPressCluster={handlePressCluster}
          selectedPolygon={geometry?.polygon ?? null}
          selectedPolyline={geometry?.polyline ?? null}
          geometryLoading={geometryLoading}
        />

        {activeRoute && NAVIGATION_PROVIDER === 'google' && MAPS_APIKEY.length > 0 && userLocation && selectedDestination && (
          <MapViewDirections
            origin={userLocation}
            destination={selectedDestination.position}
            apikey={MAPS_APIKEY}
            strokeWidth={5}
            strokeColor="#007AFF"
            onReady={(result: { distance: number; duration: number }) => {
              console.log('[MapScreen] Google route ready:', result.distance.toFixed(1), 'km');
              setRouteInfo({ distance: result.distance, duration: result.duration });
              setRouteError(null);
            }}
            onError={(err: string) => {
              console.warn('[MapScreen] Google route failed:', err);
              setRouteError(err || 'Route unavailable');
            }}
          />
        )}

        {activeRoute && NAVIGATION_PROVIDER === 'osrm' && osrmPolyline && (
          <Polyline
            coordinates={osrmPolyline}
            strokeWidth={5}
            strokeColor="#007AFF"
          />
        )}

        {activeRoute && routeError && userLocation && selectedDestination && (
          <Polyline
            coordinates={[userLocation, selectedDestination.position]}
            strokeWidth={3}
            strokeColor="#9CA3AF"
            lineDashPattern={[8, 4]}
          />
        )}

        {/* Search result pin */}
        {searchPin && (
          <Marker
            key={`search-${searchPin.latitude}`}
            ref={searchMarkerRef}
            coordinate={{ latitude: searchPin.latitude, longitude: searchPin.longitude }}
            anchor={{ x: 0.5, y: 1 }}
          >
            <CustomPinView color="#EF4444" />
            <Callout>
              <View style={styles.callout}>
                <Text style={styles.calloutText}>{searchPin.address}</Text>
                <Text style={styles.coordsText}>
                  {searchPin.latitude.toFixed(6)}, {searchPin.longitude.toFixed(6)}
                </Text>
              </View>
            </Callout>
          </Marker>
        )}

        {/* Long-press dropped pin with reverse-geocoded address */}
        {droppedPin && (
          <Marker
            key={`drop-${droppedPin.id}`}
            ref={droppedMarkerRef}
            coordinate={{ latitude: droppedPin.latitude, longitude: droppedPin.longitude }}
            anchor={{ x: 0.5, y: 1 }}
          >
            <CustomPinView color="#EF4444" />
            <Callout>
              <View style={styles.callout}>
                {droppedPin.loading ? (
                  <ActivityIndicator size="small" color="#EF4444" />
                ) : (
                  <>
                    <Text style={styles.calloutText}>{droppedPin.address}</Text>
                    <Text style={styles.coordsText}>
                      {droppedPin.latitude.toFixed(6)}, {droppedPin.longitude.toFixed(6)}
                    </Text>
                  </>
                )}
              </View>
            </Callout>
          </Marker>
        )}
      </MapView>

      {/* Thin animated bar at screen top — visible during any fetch */}
      <GeometryLoadingBar visible={geometryLoading || loading} />
      {/* Spinner below the header — only during main markers fetch */}
      <LoadingOverlay visible={loading} top={140} />

      {/* Header: search bar + free/all filter toggle */}
      <View style={styles.headerWrapper}>
        <View style={styles.searchBox}>
          <SearchBar
            mapRef={mapRef as any}
            onLocationSelect={handleLocationSelect}
            onClear={() => setSearchPin(null)}
          />
        </View>
        <View style={styles.filterBox}>
          <FilterToggle />
        </View>
      </View>

      {/* Recenter — bottom right; lifts above the keyboard when it opens */}
      <View
        style={[
          styles.recenterContainer,
          { bottom: keyboardHeight > 0 ? keyboardHeight + 12 : RECENTER_BOTTOM_DEFAULT },
        ]}
      >
        <TouchableOpacity
          style={styles.recenterButton}
          onPress={() => mapRef.current?.animateToRegion(MALAGA_REGION, 800)}
        >
          <Text style={{ fontSize: 25 }}>📍</Text>
        </TouchableOpacity>
      </View>

      {/* OSM parking zone detail + routing bottom sheet */}
      <RouteBottomSheet
        destination={selectedDestination}
        activeRoute={activeRoute}
        routeInfo={routeInfo}
        userLocation={userLocation}
        canNavigate={canNavigate}
        routeError={routeError}
        onStartRoute={handleStartRoute}
        onCancelRoute={handleCancelRoute}
        onClose={handleCloseSheet}
      />
    </View>
  );
};

const CustomPinView = ({ color }: { color: string }) => (
  <View style={pinStyles.container}>
    <View style={[pinStyles.head, { backgroundColor: color }]}>
      <View style={pinStyles.dot} />
    </View>
    <View style={[pinStyles.needle, { backgroundColor: color }]} />
  </View>
);

const styles = StyleSheet.create({
  container: { flex: 1 },
  map: { flex: 1 },
  headerWrapper: {
    position: "absolute",
    top: 35,
    left: 16,
    right: 16,
    flexDirection: "row",
    alignItems: "flex-start",
    zIndex: 100,
  },
  searchBox: { flex: 1, zIndex: 110 },
  filterBox: { marginLeft: 10, zIndex: 100 },
  legendContainer: { position: "absolute", bottom: 260, left: 15 },
  recenterContainer: { position: "absolute", bottom: 260, right: 20 },
  recenterButton: {
    backgroundColor: "white",
    width: 56,
    height: 56,
    borderRadius: 28,
    alignItems: "center",
    justifyContent: "center",
    elevation: 4,
    shadowColor: "#000",
    shadowOpacity: 0.3,
  },
  callout: {
    padding: 10,
    backgroundColor: "white",
    borderRadius: 10,
    minWidth: 140,
    alignItems: "center",
    justifyContent: "center",
  },
  calloutText: {
    fontSize: 13,
    fontWeight: "bold",
    color: "#1F2937",
    textAlign: "center",
  },
  coordsText: {
    fontSize: 11,
    color: "#6B7280",
    marginTop: 2,
    textAlign: "center",
  },
});

const pinStyles = StyleSheet.create({
  container: { alignItems: "center", width: 30, height: 40 },
  head: {
    width: 28,
    height: 28,
    borderRadius: 14,
    borderWidth: 2,
    borderColor: "white",
    alignItems: "center",
    justifyContent: "center",
  },
  dot: { width: 6, height: 6, borderRadius: 3, backgroundColor: "white" },
  needle: { width: 4, height: 12, marginTop: -3, borderRadius: 2 },
});
