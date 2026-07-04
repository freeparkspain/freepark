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
  LongPressEvent,
  Region,
} from "react-native-maps";
import * as Location from "expo-location";
import MapViewDirections from "react-native-maps-directions";

import { FilterToggle } from "../components/FilterToggle";
import { MapLegend } from "../components/MapLegend";
import { SearchBar } from "../components/SearchBar";
import { ParkingLayer } from "../components/ParkingLayer";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { GeometryLoadingBar } from "../components/GeometryLoadingBar";
import { RouteBottomSheet, SHEET_HEIGHT } from "../components/RouteBottomSheet";
import { NearbyParkingSuggestion } from "../components/NearbyParkingSuggestion";
import { useMapParkings } from "../hooks/useMapParkings";
import { useGeometryLoader } from "../hooks/useGeometryLoader";
import { OsmParking, LatLng, BBox, RouteInfo } from "../types/parking";
import { viewportRadiusMeters, haversineDistance } from "../utils/geo";
import { MAPS_APIKEY } from "../constants/maps";

export const MALAGA_REGION = {
  latitude: 36.7213,
  longitude: -4.4214,
  latitudeDelta: 0.09,
  longitudeDelta: 0.06,
};

// Default vertical offset (from the bottom of the screen) for the recenter button.
// Lowered so the button sits near the bottom; it lifts above the keyboard when open.
const RECENTER_BOTTOM_DEFAULT = 40;

// Extra clearance applied above the keyboard / bottom panel when the recenter
// button lifts off its baseline position.
const RECENTER_LIFT_MARGIN = 12;

// Detailed park-area zone outlines render only while the camera is zoomed in
// to at most this radius (meters); markers/clusters remain visible regardless.
const PARK_AREA_RADIUS_LIMIT_M = 2_000;

// ── "Driving aid" tuning ──────────────────────────────────────────────────────
// While moving, the driver shouldn't have to pan the map to discover what's
// nearby — so the app loads data around their live position on its own and
// surfaces the closest result as a single suggestion card. See the two
// effects below ("load … around the driver" and "nearest parking scan").

// Re-fetch around the driver only after a real stretch of travel — each fetch
// merges into the session cache, rebuilds the cluster index and re-persists,
// so firing it every few hundred metres compounded into the exact slowdown
// this is meant to cure. A loaded query region (see AUTO_LOAD_DELTA) already
// covers several minutes of driving, so re-arming this rarely is correct, not
// just safer — there's normally still plenty of runway left when it fires.
const AUTO_LOAD_MOVE_THRESHOLD_M = 1_200;
// Region requested around the live position — wide enough to cover a couple
// of minutes of driving ahead at city speeds, narrow enough to stay a fast,
// light `out center` query (see useMapParkings).
const AUTO_LOAD_DELTA = 0.03;
// Only suggest something genuinely "nearby" — far enough to be useful, close
// enough that driving there doesn't feel like a detour.
const NEARBY_SUGGESTION_RADIUS_M = 1_500;
// Recompute the "nearest parking" suggestion only after the driver has moved
// enough to plausibly change the answer — not on every ~10 m GPS tick. A full
// nearest-neighbour scan over a growing, several-thousand-entry cache on every
// tick was the other big contributor to the jank/ANR-style freezes.
const SUGGESTION_RECOMPUTE_THRESHOLD_M = 80;

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
  // Letting an icon tap through mid-gesture — animateToRegion, or a state
  // change that reshapes the marker/cluster set via setSelectedParkingId —
  // races the native bridge: it can end up tearing down/recycling a Marker
  // view the OS is still mid-touch on, which crashes the app outright on
  // Android. Swallowing taps until the gesture actually settles closes that
  // window; onRegionChangeComplete fires within a frame of lifting the
  // finger, so nothing feels missed in practice.
  const isGesturingRef      = useRef(false);
  // Timer that clears isGesturingRef 100 ms after the gesture ends — this
  // post-settle buffer prevents the iOS crash where onRegionChangeComplete
  // fires while the finger is still lifting (the native layer finishes the
  // animation asynchronously, so tap processing that starts immediately after
  // the event can still race the bridge animation wind-down).
  const gestureSettleTimer  = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of viewportBounds held as a ref so handlePressCluster can read the
  // latest value without having viewportBounds in its deps — keeping the
  // callback reference stable prevents all ClusterMarker components from
  // re-rendering on every pan event.
  const viewportBoundsRef   = useRef<BBox>(regionToBBox(MALAGA_REGION));
  // Centre of the last auto-load triggered by the driver's own movement —
  // lets the effect below fire only once they've actually travelled, not on
  // every sub-metre GPS jitter update.
  const lastAutoLoadCenter  = useRef<LatLng | null>(null);

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
  const [selectedParking,   setSelectedParking]   = useState<OsmParking | null>(null);
  const [selectedParkingId, setSelectedParkingId] = useState<string | null>(null);
  const [activeRoute,       setActiveRoute]       = useState(false);
  const [routeInfo,         setRouteInfo]         = useState<RouteInfo | null>(null);
  const [userLocation,      setUserLocation]      = useState<LatLng | null>(null);

  // Closest known parking area to the driver — see the throttled scan effect
  // below for why this lives in state rather than as a plain memo.
  const [nearestParking, setNearestParking] = useState<{
    parking:        OsmParking;
    distanceMeters: number;
  } | null>(null);
  // What the last scan was based on — re-scan only once the driver has moved
  // far enough to plausibly change the answer, or fresh data has arrived.
  // Re-running a full nearest-neighbour pass on every ~10 m GPS tick over a
  // growing, multi-thousand-entry cache was a major source of the freezes.
  const suggestionScanRef = useRef<{ at: LatLng; parkings: OsmParking[] } | null>(null);

  // ── Keyboard state ─────────────────────────────────────────────────────────────
  // Tracks the on-screen keyboard height so the recenter button can lift above it.
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  const hasApiKey = MAPS_APIKEY.length > 0;

  // Detailed park-area outlines (+ their centered 'P' icons) render only while
  // the camera is zoomed in to <= 2 km radius. Past that, ParkingLayer keeps
  // showing markers/clusters as usual — only the precise
  //  zone polygons hide,
  // so far-out views collapse cleanly into icon clusters instead of vanishing.
  const showZonePolygons = viewportRadiusMeters(viewportBounds) <= PARK_AREA_RADIUS_LIMIT_M;

  // Recenter button lift: rises above whichever of the keyboard / bottom info panel
  // is taller, and falls back to its baseline once both are closed.
  const recenterLift = Math.max(
    keyboardHeight  > 0 ? keyboardHeight + RECENTER_LIFT_MARGIN : 0,
    selectedParking     ? SHEET_HEIGHT + RECENTER_LIFT_MARGIN   : 0,
  );
  const recenterBottom = recenterLift > 0 ? recenterLift : RECENTER_BOTTOM_DEFAULT;

  // Show the suggestion only in the "just driving" state — hidden the instant
  // the driver is doing anything else (picked a spot, searching, dropped a
  // pin, typing), so it never competes with another panel for the same screen
  // space or attention.
  const showNearbySuggestion =
    !!nearestParking && !selectedParking && !searchPin && !droppedPin && keyboardHeight === 0;

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

  // ── Driving aid: load parking data around the driver, not just the viewport ──
  // Panning to "refresh" what's nearby is exactly what's hard to do at the
  // wheel — so instead of waiting for the user to drag the map over to wherever
  // they're headed, fetch around their live GPS position directly. This runs
  // independently of camera movement: even if the driver never touches the
  // map, data for the road ahead loads on its own as they go.
  useEffect(() => {
    if (!userLocation) return;
    const last = lastAutoLoadCenter.current;
    if (last && haversineDistance(last, userLocation) < AUTO_LOAD_MOVE_THRESHOLD_M) return;
    lastAutoLoadCenter.current = userLocation;
    loadForRegion({
      latitude:       userLocation.latitude,
      longitude:      userLocation.longitude,
      latitudeDelta:  AUTO_LOAD_DELTA,
      longitudeDelta: AUTO_LOAD_DELTA,
    });
  }, [userLocation, loadForRegion]);

  // ── Driving aid: throttled "nearest parking" scan ────────────────────────────
  // Scans visibleParkings (not the raw feed) so a driver who's filtered to
  // "free only" is never steered toward a paid spot the map itself is hiding.
  // Re-scans only when the driver has moved far enough to plausibly change the
  // answer, or fresh data has arrived — never on every individual GPS tick.
  // A full nearest-neighbour pass over a multi-thousand-entry cache, repeated
  // ~every 10 m of travel, was a major source of the freezes/ANR-style hangs.
  useEffect(() => {
    if (!userLocation) {
      suggestionScanRef.current = null;
      setNearestParking(null);
      return;
    }

    const prev        = suggestionScanRef.current;
    const movedEnough = !prev || haversineDistance(prev.at, userLocation) >= SUGGESTION_RECOMPUTE_THRESHOLD_M;
    const dataChanged = !prev || prev.parkings !== parkings;
    if (!movedEnough && !dataChanged) return;

    suggestionScanRef.current = { at: userLocation, parkings };

    let best: OsmParking | null = null;
    let bestDist = Infinity;
    for (const p of parkings) {
      const d = haversineDistance(userLocation, p.position);
      if (d < bestDist) { bestDist = d; best = p; }
    }
    setNearestParking(
      best && bestDist <= NEARBY_SUGGESTION_RADIUS_M
        ? { parking: best, distanceMeters: bestDist }
        : null,
    );
  }, [userLocation, parkings]);

  // Trigger initial OSM parking zone load (onRegionChangeComplete may not fire on first render)
  useEffect(() => {
    loadForRegion(MALAGA_REGION);
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // Once the camera is close enough to show zone outlines, fetch full ring
  // geometry for the on-screen zones that don't have it yet — in one batched
  // request (see loadZoneGeometry) rather than the heavy `out geom` bulk fetch
  // this replaced. Keeps the initial/overview load fast while still giving
  // every visible zone its precise outline once the user zooms in on it.
  useEffect(() => {
    if (!showZonePolygons) return;
    const visibleIds = parkings
      .filter(p =>
        !p.polygon && !p.polyline &&
        p.position.latitude  >= viewportBounds.south && p.position.latitude  <= viewportBounds.north &&
        p.position.longitude >= viewportBounds.west  && p.position.longitude <= viewportBounds.east,
      )
      .map(p => p.id);
    if (visibleIds.length) loadZoneGeometry(visibleIds);
  }, [showZonePolygons, parkings, viewportBounds, loadZoneGeometry]);

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
  // Fires once per gesture (native map already coalesces this — no need to
  // debounce again here). Viewport state updates immediately so clustering and
  // showZonePolygons track the camera without lag; loadForRegion has its own
  // internal debounce that coalesces the network fetch across rapid pans.
  const handleRegionChangeComplete = useCallback((region: Region) => {
    // 100 ms post-settle buffer: on iOS, onRegionChangeComplete fires while
    // the native animation is still winding down. Clearing isGesturingRef
    // immediately lets a marker tap race the bridge's cleanup and crash the
    // app. The extra 100 ms is imperceptible but closes that race window.
    if (gestureSettleTimer.current) clearTimeout(gestureSettleTimer.current);
    gestureSettleTimer.current = setTimeout(() => {
      isGesturingRef.current = false;
    }, 100);
    setLatDelta(region.latitudeDelta);
    setViewportBounds(regionToBBox(region));
    loadForRegion(region);
  }, [loadForRegion]);

  // Marks the gesture as "in flight" on every frame the camera moves under
  // the user's finger — see isGesturingRef for why icon presses check this.
  // A ref write triggers no re-render, so this is free to call every frame.
  const handleRegionChange = useCallback(() => {
    isGesturingRef.current = true;
  }, []);

  // Map tap: clears search/dropped pins AND deselects any OSM parking zone.
  // markerJustTappedRef guard prevents iOS double-fire (Marker.onPress + MapView.onPress).
  const handleMapPress = useCallback(() => {
    if (markerJustTappedRef.current) return;
    setDroppedPin(null);
    setSearchPin(null);
    setSelectedParking(null);
    setSelectedParkingId(null);
    setActiveRoute(false);
    setRouteInfo(null);
    clearGeometry();
  }, [clearGeometry]);

  // Long-press: drops a pin with reverse-geocoded address
  const handleLongPress = useCallback(async (e: LongPressEvent) => {
    setSearchPin(null);
    const { latitude, longitude } = e.nativeEvent.coordinate;
    const newId = Date.now();

    setDroppedPin({ id: newId, latitude, longitude, loading: true, address: "Searching..." });

    try {
      const [place] = await Location.reverseGeocodeAsync({ latitude, longitude });
      const addr = place
        ? `${place.street || ""} ${place.streetNumber || ""}`.trim() || "Point"
        : "Point";
      setDroppedPin((prev) =>
        prev?.id === newId ? { ...prev, address: addr, loading: false } : prev,
      );
    } catch {
      setDroppedPin((prev) =>
        prev?.id === newId ? { ...prev, address: "Point", loading: false } : prev,
      );
    }
  }, []);

  // Search result selected: places a pin and animates camera
  const handleLocationSelect = useCallback(
    async (lat: number, lon: number, addr?: string) => {
      setDroppedPin(null);
      setSearchPin({ latitude: lat, longitude: lon, address: addr || "Selected Point" });
      mapRef.current?.animateToRegion(
        { latitude: lat, longitude: lon, latitudeDelta: 0.003, longitudeDelta: 0.003 },
        800,
      );
    },
    [],
  );

  // OSM parking zone marker tapped: triggers geometry fetch and bottom sheet
  const handlePressParkingZone = useCallback((parking: OsmParking) => {
    if (isProcessingRef.current || isGesturingRef.current) return;
    isProcessingRef.current = true;
    setTimeout(() => { isProcessingRef.current = false; }, 500);

    markerJustTappedRef.current = true;
    requestAnimationFrame(() => { markerJustTappedRef.current = false; });

    setSelectedParking(parking);
    setSelectedParkingId(parking.id);
    setActiveRoute(false);
    setRouteInfo(null);
    loadGeometry(parking);
  }, [loadGeometry]);

  // Suggestion card tapped: the spot may well be off-screen (it's chosen by
  // proximity to the driver, not to the current viewport), so — unlike a
  // marker tap — also glide the camera to it. Reuses handlePressParkingZone
  // for the selection/geometry/sheet part so behaviour stays identical to
  // tapping the marker directly.
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
  // the camera moves (which was causing O(clusters) native Marker updates per pan).
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
  const handleStartRoute  = useCallback(() => { setActiveRoute(true); setRouteInfo(null); }, []);
  const handleCancelRoute = useCallback(() => { setActiveRoute(false); setRouteInfo(null); }, []);
  const handleCloseSheet  = useCallback(() => {
    setSelectedParking(null);
    setSelectedParkingId(null);
    setActiveRoute(false);
    setRouteInfo(null);
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
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        mapPadding={{ top: 120, right: 0, bottom: 0, left: 0 }}
      >
        <UrlTile
          urlTemplate="https://openstreetmap.org{z}/{x}/{y}.png"
          zIndex={-1}
        />

        {/* OSM parking zones fetched from Overpass API — markers always render
            (clustering naturally collapses them at low zoom); precise zone
            outlines additionally show once the camera is within 2 km. */}
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
          showZonePolygons={showZonePolygons}
        />

        {/* Route polyline (requires Google Maps API key in constants/maps.ts) */}
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

      {/* Driving aid — closest known parking area to the driver's live position.
          Sits just under the header, out of the way of both the map's centre
          (where attention is while moving) and the bottom sheet/recenter
          button; hides itself the moment anything else takes the screen. */}
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
      <View
        style={[
          styles.recenterContainer,
          { bottom: recenterBottom },
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
  nearbySuggestionWrapper: {
    position: "absolute",
    top: 96,
    left: 16,
    right: 16,
    zIndex: 90,
  },
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
