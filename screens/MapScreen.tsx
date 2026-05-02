import React, { useCallback, useEffect, useRef, useState } from 'react';
import { View, TouchableOpacity, Text, StyleSheet } from 'react-native';
import MapView, { UrlTile, PROVIDER_DEFAULT, Region } from 'react-native-maps';
import MapViewDirections from 'react-native-maps-directions';
import * as Location from 'expo-location';
import { OsmParking, LatLng, BBox, RouteInfo } from '../types/parking';
import { useMapParkings } from '../hooks/useMapParkings';
import { useGeometryLoader } from '../hooks/useGeometryLoader';
import { ParkingLayer } from '../components/ParkingLayer';
import { LoadingOverlay }      from '../components/LoadingOverlay';
import { GeometryLoadingBar }  from '../components/GeometryLoadingBar';
import { RouteBottomSheet }    from '../components/RouteBottomSheet';
import { MAPS_APIKEY } from '../constants/maps';

export const MALAGA_REGION: Region = {
  latitude:       36.7213,
  longitude:      -4.4214,
  latitudeDelta:  0.09,
  longitudeDelta: 0.06,
};

function regionToBBox(r: Region): BBox {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

export const MapScreen: React.FC = () => {
  const mapRef               = useRef<MapView>(null);
  const regionDebounceTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Guard: Marker.onPress and MapView.onPress both fire for the same physical tap
  // on iOS (UITapGestureRecognizer runs alongside MKAnnotationView selection).
  // We set this flag inside handlePressMarker so the map-press handler can bail.
  const markerJustTappedRef  = useRef(false);
  // Interaction lock: prevents multiple rapid taps on different markers from
  // queuing up simultaneous state updates and geometry fetches.
  const isProcessingRef      = useRef(false);

  // ── Step 1: fast markers (out center — centroid only, no geometry) ────────
  const { parkings, loading, loadForRegion } = useMapParkings();

  // ── Step 2: lazy geometry (fetched on tap, cached per parking ID) ─────────
  const { geometry, geometryLoading, loadGeometry, clearGeometry } = useGeometryLoader();

  // Viewport — latDelta drives zoom level; bounds feed supercluster getClusters()
  const [latDelta,       setLatDelta]       = useState(MALAGA_REGION.latitudeDelta);
  const [viewportBounds, setViewportBounds] = useState<BBox>(() => regionToBBox(MALAGA_REGION));

  // Selected parking — drives geometry fetch + bottom sheet
  const [selectedParking,   setSelectedParking]   = useState<OsmParking | null>(null);
  // ID-only selection state — sole gate for polygon/polyline rendering
  const [selectedParkingId, setSelectedParkingId] = useState<string | null>(null);

  // Navigation
  const [activeRoute, setActiveRoute] = useState(false);
  const [routeInfo,   setRouteInfo]   = useState<RouteInfo | null>(null);

  // User location — required for straight-line distance + routing
  const [userLocation, setUserLocation] = useState<LatLng | null>(null);

  const hasApiKey = MAPS_APIKEY.length > 0;

  // ── Location permission + live tracking ───────────────────────────────────
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== 'granted') return;
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (loc) =>
          setUserLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude }),
      );
    })();
    return () => { sub?.remove(); };
  }, []);

  // Trigger initial data load (onRegionChangeComplete may not fire on first render)
  useEffect(() => {
    loadForRegion(MALAGA_REGION);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Clean up debounce timer on unmount
  useEffect(() => {
    return () => {
      if (regionDebounceTimer.current) clearTimeout(regionDebounceTimer.current);
    };
  }, []);

  // ── Map event handlers ────────────────────────────────────────────────────
  // Debounce the entire handler so rapid onRegionChangeComplete bursts (e.g.
  // back-to-back programmatic animations) collapse into a single state update
  // and a single API-trigger — prevents Supercluster rebuilds and API spam.
  const handleRegionChangeComplete = useCallback((region: Region) => {
    if (regionDebounceTimer.current) clearTimeout(regionDebounceTimer.current);
    regionDebounceTimer.current = setTimeout(() => {
      setLatDelta(region.latitudeDelta);
      setViewportBounds(regionToBBox(region));
      loadForRegion(region);
    }, 500);
  }, [loadForRegion]);

  const handlePressMarker = useCallback((parking: OsmParking) => {
    // Drop fast-tap repeats — if a state update + geometry fetch is already
    // in flight, ignore the new tap.  The lock releases after 300 ms which is
    // enough for React to flush the first batch and for the native map to
    // visually confirm the selection.
    if (isProcessingRef.current) return;
    isProcessingRef.current = true;
    setTimeout(() => { isProcessingRef.current = false; }, 300);

    // Raise the flag so handleMapPress (which fires immediately after on iOS)
    // knows this touch was on a marker and should not deselect.
    markerJustTappedRef.current = true;
    requestAnimationFrame(() => { markerJustTappedRef.current = false; });

    setSelectedParking(parking);
    setSelectedParkingId(parking.id);
    setActiveRoute(false);
    setRouteInfo(null);
    loadGeometry(parking);
  }, [loadGeometry]);

  const handlePressCluster = useCallback((position: LatLng) => {
    // Zoom in by halving both deltas — breaks the cluster apart at the next zoom level
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

  // ── Bottom sheet handlers ─────────────────────────────────────────────────
  const handleStartRoute = useCallback(() => {
    setActiveRoute(true);
    setRouteInfo(null);
  }, []);

  const handleCancelRoute = useCallback(() => {
    setActiveRoute(false);
    setRouteInfo(null);
  }, []);

  // Called by the bottom-sheet close button — always deselects.
  const handleCloseSheet = useCallback(() => {
    setSelectedParking(null);
    setSelectedParkingId(null);
    setActiveRoute(false);
    setRouteInfo(null);
    clearGeometry();
  }, [clearGeometry]);

  // Called by MapView.onPress (empty-map tap) — deselects ONLY when the tap
  // was not on a marker.  Without this guard, Marker.onPress + MapView.onPress
  // both fire for the same touch on iOS, causing an instant open-then-close.
  const handleMapPress = useCallback(() => {
    if (markerJustTappedRef.current) return;
    setSelectedParking(null);
    setSelectedParkingId(null);
    setActiveRoute(false);
    setRouteInfo(null);
    clearGeometry();
  }, [clearGeometry]);

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
        onRegionChangeComplete={handleRegionChangeComplete}
        onPress={handleMapPress}
      >
        <UrlTile
          urlTemplate="https://tile.openstreetmap.org/{z}/{x}/{y}.png"
          maximumZ={19}
          flipY={false}
          zIndex={-1}
        />

        {activeRoute && hasApiKey && userLocation && selectedParking && (
          <MapViewDirections
            origin={userLocation}
            destination={selectedParking.position}
            apikey={MAPS_APIKEY}
            strokeWidth={5}
            strokeColor="#007AFF"
            onReady={(result: { distance: number; duration: number }) =>
              setRouteInfo({ distance: result.distance, duration: result.duration })
            }
          />
        )}

        <ParkingLayer
          parkings={parkings}
          selectedParkingId={selectedParkingId}
          latitudeDelta={latDelta}
          viewportBounds={viewportBounds}
          onPressMarker={handlePressMarker}
          onPressCluster={handlePressCluster}
          selectedPolygon={geometry?.polygon ?? null}
          selectedPolyline={geometry?.polyline ?? null}
          geometryLoading={geometryLoading}
        />
      </MapView>

      {/* Thin sliding bar at top — geometry fetch OR main fetch (mirror rotation
          can take several seconds; give the user visible progress for both) */}
      <GeometryLoadingBar visible={geometryLoading || loading} />

      {/* Spinner below status bar — visible during the main markers fetch */}
      <LoadingOverlay visible={loading} />

      {/* Recenter — sits above the bottom sheet (sheet height = 240) */}
      <View style={styles.recenterWrap}>
        <TouchableOpacity
          onPress={handleRecenter}
          activeOpacity={0.85}
          style={styles.recenterBtn}
        >
          <Text style={styles.recenterIcon}>📍</Text>
        </TouchableOpacity>
      </View>

      <RouteBottomSheet
        parking={selectedParking}
        activeRoute={activeRoute}
        routeInfo={routeInfo}
        userLocation={userLocation}
        hasApiKey={hasApiKey}
        onStartRoute={handleStartRoute}
        onCancelRoute={handleCancelRoute}
        onClose={handleCloseSheet}
      />
    </View>
  );
};

const styles = StyleSheet.create({
  container: { flex: 1 },
  map:       { flex: 1 },
  recenterWrap: {
    position: 'absolute',
    bottom:   260,
    right:    16,
  },
  recenterBtn: {
    backgroundColor: '#ffffff',
    width: 48, height: 48, borderRadius: 24,
    justifyContent:  'center',
    alignItems:      'center',
    shadowColor:     '#000',
    shadowOffset:    { width: 0, height: 2 },
    shadowOpacity:   0.15,
    shadowRadius:    6,
    elevation:       8,
  },
  recenterIcon: { fontSize: 20 },
});
