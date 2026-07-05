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
  PROVIDER_GOOGLE,
  Marker,
  Callout,
  MapMarker,
  Polyline,
  LongPressEvent,
  Region,
} from "react-native-maps";
import * as Location from "expo-location";
import MapViewDirections from "react-native-maps-directions";

import { FilterToggle } from "../components/FilterToggle";
import { SearchBar } from "../components/SearchBar";
import { ParkingLayer } from "../components/ParkingLayer";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { GeometryLoadingBar } from "../components/GeometryLoadingBar";
import { RouteBottomSheet, SHEET_HEIGHT } from "../components/RouteBottomSheet";
import { NearbyParkingSuggestion } from "../components/NearbyParkingSuggestion";
import { useMapParkings } from "../hooks/useMapParkings";
import { useGeometryLoader } from "../hooks/useGeometryLoader";
import { useParkingStore } from "../store/useParkingStore";
import { OsmParking, LatLng, BBox, RouteInfo, SelectedDestination } from "../types/parking";
import { MAPS_APIKEY, NAVIGATION_PROVIDER } from "../constants/maps";
import { fetchOsrmRoute } from "../services/navigation/osrmNavigation";
import { viewportRadiusMeters, haversineDistance, deltaToZoom } from "../utils/geo";
import { isPaidParking } from "../utils/parking";

export const MALAGA_REGION = {
  latitude: 36.7213,
  longitude: -4.4214,
  latitudeDelta: 0.09,
  longitudeDelta: 0.06,
};

const RECENTER_BOTTOM_DEFAULT    = 40;
const RECENTER_LIFT_MARGIN       = 12;
const PARK_AREA_RADIUS_LIMIT_M   = 2_000;
const NEARBY_SUGGESTION_RADIUS_M = 1_500;
const SUGGESTION_RECOMPUTE_THRESHOLD_M = 80;
// Below this zoom, parking markers hide entirely (Google-Maps-like) — even
// when display is enabled. Matches the fetch threshold (useMapParkings MIN_ZOOM)
// and the default MALAGA_REGION view (~zoom 12) so a Search Parking press from
// the initial camera actually reveals markers; clustering keeps city-zoom dense
// areas to a handful of bubbles, so this is safe without going higher.
const PARKING_MIN_VISIBLE_ZOOM   = 12;

// Stable empty array so gating parking off doesn't allocate a new reference
// every render (which would thrash the Supercluster index memo downstream).
const EMPTY_PARKINGS: OsmParking[] = [];

function regionToBBox(r: Region): BBox {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

export const MapScreen: React.FC = () => {
  // ── OSM parking zone hooks ───────────────────────────────────────────────────
  const { parkings, loading, loadForRegion, loadZoneGeometry } = useMapParkings();
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
  // True while the user has an active pinch/pan gesture on the map (set on
  // every onRegionChange tick, cleared once onRegionChangeComplete fires).
  // Letting an icon tap through mid-gesture races the native bridge and can
  // crash the app outright on Android. Swallowing taps until the gesture
  // actually settles closes that window.
  const isGesturingRef      = useRef(false);
  // Timer that clears isGesturingRef 100 ms after the gesture ends — this
  // post-settle buffer prevents the iOS crash where onRegionChangeComplete
  // fires while the finger is still lifting (the native layer finishes the
  // animation asynchronously).
  const gestureSettleTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of viewportBounds held as a ref so handlePressCluster can read the
  // latest value without having viewportBounds in its deps — keeping the
  // callback reference stable prevents all ClusterMarker components from
  // re-rendering on every pan event.
  const viewportBoundsRef   = useRef<BBox>(regionToBBox(MALAGA_REGION));
  // Latest camera region — the "Search Parking" button fetches for this on
  // demand (parking is never auto-loaded on pan/zoom anymore).
  const lastRegionRef       = useRef<Region>(MALAGA_REGION);
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
  // Keep the ref in sync so handlePressCluster can read the current bounds
  // without capturing viewportBounds in its deps (which would recreate the
  // callback — and re-render every ClusterMarker — on every pan event).
  viewportBoundsRef.current = viewportBounds;
  const [selectedParkingId,   setSelectedParkingId]   = useState<string | null>(null);
  const [activeRoute,         setActiveRoute]         = useState(false);
  const [routeInfo,           setRouteInfo]           = useState<RouteInfo | null>(null);
  const [routeError,          setRouteError]          = useState<string | null>(null);
  const [osrmPolyline,        setOsrmPolyline]        = useState<LatLng[] | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(null);
  const [userLocation,        setUserLocation]        = useState<LatLng | null>(null);
  const [locationDenied,      setLocationDenied]      = useState(false);

  // Parking is only rendered after the user explicitly taps "Search Parking".
  // Cache still hydrates into `parkings` in the background, but nothing shows
  // on the map until this flag flips true. Zooming out below the threshold
  // resets it (see handleRegionChangeComplete), so zooming back in requires a
  // fresh press — exactly how Google Maps gates its own POIs.
  const [parkingDisplayEnabled, setParkingDisplayEnabled] = useState(false);

  // Closest known parking area to the driver — see the throttled scan effect below.
  const [nearestParking, setNearestParking] = useState<{
    parking:        OsmParking;
    distanceMeters: number;
  } | null>(null);
  const suggestionScanRef = useRef<{ at: LatLng; parkings: OsmParking[] } | null>(null);

  // ── Keyboard state ─────────────────────────────────────────────────────────────
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // ── Free/paid filter ─────────────────────────────────────────────────────────
  // Drives which OSM markers/clusters render. "Free Only" hides paid spots from
  // the map (and clustering) but never deletes them from the cache.
  const filterOnlyFree = useParkingStore((s) => s.filterOnlyFree);

  // Gate rendering by zoom + manual-display flag, THEN apply the free/paid
  // filter. Source `parkings` (and the persistent cache) are never mutated —
  // this only decides what is drawn.
  const currentZoom    = deltaToZoom(latDelta);
  const parkingVisible = parkingDisplayEnabled && currentZoom >= PARKING_MIN_VISIBLE_ZOOM;
  const visibleParkings = React.useMemo(() => {
    if (!parkingVisible) return EMPTY_PARKINGS;
    return filterOnlyFree ? parkings.filter((p) => !isPaidParking(p.tags)) : parkings;
  }, [parkingVisible, parkings, filterOnlyFree]);

  const canNavigate = NAVIGATION_PROVIDER === 'osrm' || MAPS_APIKEY.length > 0;

  const showZonePolygons = viewportRadiusMeters(viewportBounds) <= PARK_AREA_RADIUS_LIMIT_M;

  const recenterLift = Math.max(
    keyboardHeight      > 0 ? keyboardHeight   + RECENTER_LIFT_MARGIN : 0,
    selectedDestination     ? SHEET_HEIGHT     + RECENTER_LIFT_MARGIN : 0,
  );
  const recenterBottom = recenterLift > 0 ? recenterLift : RECENTER_BOTTOM_DEFAULT;

  const showNearbySuggestion =
    !!nearestParking && !selectedDestination && !searchPin && !droppedPin && keyboardHeight === 0;

  // ── Effects ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (droppedPin && !droppedPin.loading) {
      const t = setTimeout(() => droppedMarkerRef.current?.showCallout(), 400);
      return () => clearTimeout(t);
    }
  }, [droppedPin?.id, droppedPin?.loading]);

  useEffect(() => {
    if (searchPin) {
      const t = setTimeout(() => searchMarkerRef.current?.showCallout(), 500);
      return () => clearTimeout(t);
    }
  }, [searchPin]);

  // Location permission + live tracking for routing. Grabs a fast one-shot fix
  // via getCurrentPositionAsync FIRST (watchPositionAsync can take many seconds
  // to emit its first sample — that lag was the "Waiting for location…" the
  // bottom sheet got stuck on), then subscribes for live updates.
  useEffect(() => {
    let sub: Location.LocationSubscription | null = null;
    let cancelled = false;
    (async () => {
      const { status } = await Location.requestForegroundPermissionsAsync();
      if (status !== "granted") {
        if (!cancelled) setLocationDenied(true);
        return;
      }
      if (!cancelled) setLocationDenied(false);
      try {
        const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
        if (!cancelled) {
          setUserLocation({ latitude: pos.coords.latitude, longitude: pos.coords.longitude });
        }
      } catch {
        /* one-shot fix failed — the watcher below still provides a position */
      }
      sub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (loc) =>
          setUserLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude }),
      );
    })();
    return () => { cancelled = true; sub?.remove(); };
  }, []);

  // On-demand location acquisition — used by "Start Route" and the sheet's
  // "Enable location" retry. Requests permission if needed and resolves a fresh
  // fix without waiting for the watcher. Returns null (never throws) if the
  // user has denied access, so the caller can fall back gracefully.
  const ensureUserLocation = useCallback(async (): Promise<LatLng | null> => {
    if (userLocation) return userLocation;
    try {
      let { status } = await Location.getForegroundPermissionsAsync();
      if (status !== "granted") {
        status = (await Location.requestForegroundPermissionsAsync()).status;
      }
      if (status !== "granted") { setLocationDenied(true); return null; }
      setLocationDenied(false);
      const pos = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.Balanced });
      const loc = { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
      setUserLocation(loc);
      return loc;
    } catch {
      return null;
    }
  }, [userLocation]);

  // Driving aid: throttled "nearest parking" scan.
  // Scans visibleParkings (the filtered set) so a driver on "Free Only" is
  // never steered toward a paid spot the map itself is hiding. Re-scans only
  // when the driver has moved far enough to plausibly change the answer, or
  // fresh data arrived — never on every ~10 m GPS tick.
  useEffect(() => {
    if (!userLocation) {
      suggestionScanRef.current = null;
      setNearestParking(null);
      return;
    }

    const prev        = suggestionScanRef.current;
    const movedEnough = !prev || haversineDistance(prev.at, userLocation) >= SUGGESTION_RECOMPUTE_THRESHOLD_M;
    const dataChanged = !prev || prev.parkings !== visibleParkings;
    if (!movedEnough && !dataChanged) return;

    suggestionScanRef.current = { at: userLocation, parkings: visibleParkings };

    let best: OsmParking | null = null;
    let bestDist = Infinity;
    for (const p of visibleParkings) {
      const d = haversineDistance(userLocation, p.position);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    setNearestParking(
      best && bestDist <= NEARBY_SUGGESTION_RADIUS_M
        ? { parking: best, distanceMeters: bestDist }
        : null,
    );
  }, [userLocation, visibleParkings]);

  // Once parking is displayed AND the camera is close enough to show zone
  // outlines, fetch full ring geometry for the on-screen zones that don't have
  // it yet — in one batched request. Gated by parkingVisible so it never fires
  // while markers are hidden (no display = no geometry pulls). Iterates the
  // filtered `visibleParkings` so paid zones aren't fetched while on Free Only.
  useEffect(() => {
    if (!parkingVisible || !showZonePolygons) return;
    const visibleIds = visibleParkings
      .filter(p =>
        !p.polygon && !p.polyline &&
        p.position.latitude  >= viewportBounds.south && p.position.latitude  <= viewportBounds.north &&
        p.position.longitude >= viewportBounds.west  && p.position.longitude <= viewportBounds.east,
      )
      .map(p => p.id);
    if (visibleIds.length) loadZoneGeometry(visibleIds);
  }, [parkingVisible, showZonePolygons, visibleParkings, viewportBounds, loadZoneGeometry]);

  // Free Only just hid the selected paid parking — clear its selection, geometry
  // and any route targeting it so nothing points at a spot that's no longer
  // renderable (the stale selected-id + geometry was the filter-toggle crash).
  // Source data/cache is untouched; toggling back to All Parking restores it.
  // Looks the spot up in the FULL source `parkings`, since by now it's already
  // been filtered out of `visibleParkings`.
  useEffect(() => {
    if (!filterOnlyFree || !selectedParkingId) return;
    const sel = parkings.find(p => p.id === selectedParkingId);
    if (!sel || !isPaidParking(sel.tags)) return;
    setSelectedParkingId(null);
    clearGeometry();
    setSelectedDestination(prev =>
      prev && prev.type === 'parking' && prev.id === selectedParkingId ? null : prev);
    osrmFetchIdRef.current++;
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
  }, [filterOnlyFree, selectedParkingId, parkings, clearGeometry]);

  // Keyboard listeners: lift the recenter button above the keyboard while it is open.
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
  const handleRegionChangeComplete = useCallback((region: Region) => {
    // 100 ms post-settle buffer: on iOS, onRegionChangeComplete fires while
    // the native animation is still winding down. Clearing isGesturingRef
    // immediately lets a marker tap race the bridge's cleanup and crash the app.
    if (gestureSettleTimer.current) clearTimeout(gestureSettleTimer.current);
    gestureSettleTimer.current = setTimeout(() => {
      isGesturingRef.current = false;
    }, 100);
    // Keep clustering + zone-outline visibility tracking the camera, but do NOT
    // fetch parking on move — the user pulls new data explicitly via the
    // "Search Parking" button (see handleSearchParking). This is what stops the
    // constant Overpass churn that drove the jank/crashes during browsing.
    lastRegionRef.current = region;
    setLatDelta(region.latitudeDelta);
    setViewportBounds(regionToBBox(region));
    // Zoomed out below the display threshold → hide parking and require a fresh
    // "Search Parking" press when zooming back in (Google-Maps-like behaviour).
    if (deltaToZoom(region.latitudeDelta) < PARKING_MIN_VISIBLE_ZOOM) {
      setParkingDisplayEnabled(false);
    }
  }, []);

  // Manual parking fetch + display for the current viewport — the ONLY path
  // that pulls new Overpass data and the ONLY thing that reveals markers.
  // loadForRegion keeps its own debounce/coverage/cooldown guards, so repeated
  // taps over an already-loaded area are cheap no-ops (no request storm).
  const handleSearchParking = useCallback(() => {
    console.log('[MapScreen] Search Parking pressed for current viewport');
    setParkingDisplayEnabled(true);
    loadForRegion(lastRegionRef.current);
  }, [loadForRegion]);

  // Marks the gesture as "in flight" on every frame the camera moves.
  const handleRegionChange = useCallback(() => {
    isGesturingRef.current = true;
  }, []);

  // Map tap: clears all selections and route state.
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

  // Long-press: drops a pin, sets it as navigation destination, reverse-geocodes address.
  const handleLongPress = useCallback(async (e: LongPressEvent) => {
    setSearchPin(null);
    setSelectedParkingId(null);
    clearGeometry();

    const { latitude, longitude } = e.nativeEvent.coordinate;
    const newId      = Date.now();
    const pinId      = `pin-${newId}`;
    const position   = { latitude, longitude };
    const coordTitle = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

    console.log('[MapScreen] long-press pin placed at:', coordTitle);

    setDroppedPin({ id: newId, latitude, longitude, loading: true, address: 'Searching…' });
    setSelectedDestination({ id: pinId, type: 'pin', title: coordTitle, position });
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);

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

  // Search result selected: places a pin, sets navigation destination, animates camera.
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
      console.log('[MapScreen] navigation sheet opening for search result');
    },
    [clearGeometry],
  );

  // OSM parking zone marker tapped: triggers geometry fetch and bottom sheet.
  const handlePressParkingZone = useCallback((parking: OsmParking) => {
    if (isProcessingRef.current || isGesturingRef.current) return;
    isProcessingRef.current = true;
    setTimeout(() => { isProcessingRef.current = false; }, 500);

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

    console.log('[MapScreen] navigation sheet opening for parking:', dest.title);
  }, [loadGeometry]);

  // Suggestion card tapped: animates the camera to the spot then selects it.
  const handlePressNearbySuggestion = useCallback(() => {
    if (!nearestParking) return;
    const { parking } = nearestParking;
    mapRef.current?.animateToRegion(
      { ...parking.position, latitudeDelta: 0.01, longitudeDelta: 0.01 },
      600,
    );
    handlePressParkingZone(parking);
  }, [nearestParking, handlePressParkingZone]);

  // Cluster tapped: zoom in to break the cluster apart.
  // Reads bounds from viewportBoundsRef (not state) so this callback is stable
  // across pans — preventing every ClusterMarker from re-rendering each time
  // the camera moves.
  const handlePressCluster = useCallback((position: LatLng) => {
    if (isGesturingRef.current) return;
    const bounds = viewportBoundsRef.current;
    mapRef.current?.animateToRegion(
      {
        latitude:       position.latitude,
        longitude:      position.longitude,
        latitudeDelta:  (bounds.north - bounds.south) * 0.5,
        longitudeDelta: (bounds.east  - bounds.west)  * 0.5,
      },
      400,
    );
  }, []); // stable — reads viewport from ref at call time

  // ── Bottom sheet handlers ─────────────────────────────────────────────────────
  // Builds the route INSIDE the app. Enters the active-route state immediately
  // (so the sheet shows "Calculating…"), then makes sure we have a location —
  // acquiring one on demand if the watcher hasn't produced one yet, which is
  // what kept the sheet stuck on "Waiting for location…". Google routes render
  // via MapViewDirections in the JSX (needs userLocation in state); OSRM routes
  // are fetched here. On failure the JSX draws a dashed straight-line fallback.
  const handleStartRoute = useCallback(async () => {
    if (!selectedDestination) return;
    console.log('[MapScreen] Start Route pressed for:', selectedDestination.title);
    setActiveRoute(true);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);

    const loc = userLocation ?? await ensureUserLocation();
    if (!loc) {
      console.warn('[MapScreen] Start Route: no location available');
      setRouteError('Location unavailable — enable location access to route');
      return;
    }

    // Google provider: MapViewDirections in the JSX draws the polyline + ETA
    // once userLocation is in state (ensureUserLocation set it above).
    if (NAVIGATION_PROVIDER !== 'osrm') return;

    const fetchId = ++osrmFetchIdRef.current;
    console.log('[MapScreen] starting OSRM route fetch...');
    fetchOsrmRoute(loc, selectedDestination.position)
      .then((r) => {
        if (osrmFetchIdRef.current !== fetchId) return;
        console.log('[MapScreen] route ready:', r.routeInfo.distance.toFixed(1), 'km');
        setOsrmPolyline(r.polyline);
        setRouteInfo(r.routeInfo);
      })
      .catch((e) => {
        if (osrmFetchIdRef.current !== fetchId) return;
        const msg = e instanceof Error ? e.message : 'Route unavailable';
        console.warn('[MapScreen] route failed:', msg);
        setRouteError(msg);
      });
  }, [userLocation, selectedDestination, ensureUserLocation]);

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
        // Google Maps engine on BOTH iOS and Android (never Apple Maps). The
        // native SDK key is injected via app.config.js from
        // EXPO_PUBLIC_GOOGLE_MAPS_API_KEY. Requires a dev/prebuild — in Expo Go
        // on iOS the provider silently falls back to Apple Maps.
        provider={PROVIDER_GOOGLE}
        initialRegion={MALAGA_REGION}
        showsUserLocation
        showsMyLocationButton={false}
        onLongPress={handleLongPress}
        onPress={handleMapPress}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        mapPadding={{ top: 120, right: 0, bottom: 0, left: 0 }}
      >
        {/* OSM parking zones fetched from Overpass API — clusters + polygons.
            Rendered over the Google basemap; free/paid filter applied upstream. */}
        <ParkingLayer
          parkings={visibleParkings}
          selectedParkingId={selectedParkingId}
          latitudeDelta={latDelta}
          viewportBounds={viewportBounds}
          onPressMarker={handlePressParkingZone}
          onPressCluster={handlePressCluster}
          selectedPolygon={geometry?.polygon ?? null}
          selectedPolyline={geometry?.polyline ?? null}
          geometryLoading={geometryLoading}
          showZonePolygons={showZonePolygons}
        />

        {/* In-app Google route — rendered by MapViewDirections as a polyline */}
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

        {/* OSRM route polyline (only when NAVIGATION_PROVIDER=osrm) */}
        {activeRoute && NAVIGATION_PROVIDER === 'osrm' && osrmPolyline && (
          <Polyline
            coordinates={osrmPolyline}
            strokeWidth={5}
            strokeColor="#007AFF"
          />
        )}

        {/* Fallback straight dashed line when the route provider fails */}
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
          <FilterToggle count={visibleParkings.length} />
        </View>
      </View>

      {/* Manual "Search Parking" — the only trigger that pulls new Overpass
          data. Always visible directly under the search bar; the search
          results dropdown (higher zIndex) overlays it while typing. */}
      <View style={styles.searchParkingWrapper} pointerEvents="box-none">
        <TouchableOpacity
          style={[styles.searchParkingBtn, loading && styles.searchParkingBtnBusy]}
          onPress={handleSearchParking}
          activeOpacity={0.85}
          disabled={loading}
        >
          <Text style={styles.searchParkingText}>
            {loading ? 'Searching…' : '🅿  Search Parking'}
          </Text>
        </TouchableOpacity>
      </View>

      {/* Driving aid — closest known parking area to the driver's live position */}
      {showNearbySuggestion && nearestParking && (
        <View style={styles.nearbySuggestionWrapper} pointerEvents="box-none">
          <NearbyParkingSuggestion
            parking={nearestParking.parking}
            distanceMeters={nearestParking.distanceMeters}
            onPress={handlePressNearbySuggestion}
          />
        </View>
      )}

      {/* Recenter — bottom right; lifts above the keyboard and/or the bottom info panel */}
      <View style={[styles.recenterContainer, { bottom: recenterBottom }]}>
        <TouchableOpacity
          style={styles.recenterButton}
          onPress={() => mapRef.current?.animateToRegion(MALAGA_REGION, 800)}
        >
          <Text style={{ fontSize: 25 }}>📍</Text>
        </TouchableOpacity>
      </View>

      {/* Universal destination + routing bottom sheet */}
      <RouteBottomSheet
        destination={selectedDestination}
        activeRoute={activeRoute}
        routeInfo={routeInfo}
        userLocation={userLocation}
        canNavigate={canNavigate}
        routeError={routeError}
        locationDenied={locationDenied}
        onStartRoute={handleStartRoute}
        onCancelRoute={handleCancelRoute}
        onRequestLocation={ensureUserLocation}
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
  searchParkingWrapper: {
    position: "absolute",
    top: 92,
    left: 16,
    right: 16,
    zIndex: 80,
  },
  searchParkingBtn: {
    backgroundColor: "#16A34A",
    borderRadius: 16,
    paddingVertical: 14,
    alignItems: "center",
    justifyContent: "center",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 4 },
    shadowOpacity: 0.22,
    shadowRadius: 8,
    elevation: 6,
  },
  searchParkingBtnBusy: { backgroundColor: "#4B9E6A" },
  searchParkingText: {
    color: "#ffffff",
    fontSize: 15,
    fontWeight: "800",
    letterSpacing: 0.2,
  },
  nearbySuggestionWrapper: {
    position: "absolute",
    top: 150,
    left: 16,
    right: 16,
    zIndex: 70,
  },
  legendContainer: { position: "absolute", bottom: 260, left: 15 },
  recenterContainer: { position: "absolute", right: 20 },
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
