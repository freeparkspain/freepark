import React, { useCallback, useEffect, useRef, useState } from "react";
import {
  View,
  TouchableOpacity,
  Text,
  StyleSheet,
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
import { useWindowDimensions } from "react-native";
import * as Location from "expo-location";
import { useNavigation as useStackNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import MapViewDirections from "react-native-maps-directions";

import { FilterToggle } from "../components/FilterToggle";
import { SearchBar } from "../components/SearchBar";
import { ParkingLayer } from "../components/ParkingLayer";
import { LoadingOverlay } from "../components/LoadingOverlay";
import { GeometryLoadingBar } from "../components/GeometryLoadingBar";
import { RouteBottomSheet, SHEET_HEIGHT } from "../components/RouteBottomSheet";
import { NearbyParkingSuggestion } from "../components/NearbyParkingSuggestion";
import { NavigationPanel } from "../components/NavigationPanel";
import { NavigationArrow } from "../components/NavigationArrow";
import { NavigationRoute } from "../components/NavigationRoute";
import { NavigationRecenterButton } from "../components/NavigationRecenterButton";
import { useMapParkings } from "../hooks/useMapParkings";
import { useGeometryLoader } from "../hooks/useGeometryLoader";
import { useNavigation } from "../hooks/useNavigation";
import { useCarTracking } from "../hooks/useCarTracking";
import { useRouteProgress } from "../hooks/useRouteProgress";
import { useNavigationCamera } from "../hooks/useNavigationCamera";
import { useParkingStore } from "../store/useParkingStore";
import { OsmParking, LatLng, BBox, RouteInfo, SelectedDestination } from "../types/parking";
import { MAPS_APIKEY, NAVIGATION_PROVIDER } from "../constants/maps";
import { viewportRadiusMeters, haversineDistance, deltaToZoom, simplifyCoords } from "../utils/geo";
import { isPaidParking } from "../utils/parking";
import {
  getVisibleTileIds,
  getParkingDataZoom,
  MAX_TILES_PER_VIEWPORT,
} from "../services/parking/parkingTiles";

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
// Stable empty route coords for the car-tracking hook when not navigating.
const NO_COORDS: LatLng[] = [];

// Approximate heights of the navigation overlays (from their own styles), used
// to compute usable map area for camera padding — NOT device-specific offsets.
const NAV_TOP_CARD_HEIGHT    = 110;
const NAV_BOTTOM_BAR_HEIGHT  = 96;

function regionToBBox(r: Region): BBox {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

/** True when `inner` lies fully within `outer` — used to dedupe search zones. */
function bboxContains(outer: BBox, inner: BBox): boolean {
  return (
    inner.south >= outer.south && inner.north <= outer.north &&
    inner.west  >= outer.west  && inner.east  <= outer.east
  );
}

/** Max number of accumulated search zones kept (bounds memory / perf guard). */
const MAX_SEARCH_ZONES = 24;

export const MapScreen: React.FC = () => {
  // ── OSM parking zone hooks ───────────────────────────────────────────────────
  const { parkings, loading, loadForRegion, loadZoneGeometry } = useMapParkings();
  const { geometry, geometryLoading, loadGeometry, clearGeometry } = useGeometryLoader();

  // ── Turn-by-turn navigation (OSRM + expo-location + expo-speech) ─────────────
  const nav = useNavigation();
  const navActive = nav.isActive;

  // Hide the app header while navigating so the instruction card can sit at the
  // top safe area and the map gets maximum room (BUG 7). Restored on exit.
  const stackNav = useStackNavigation();
  useEffect(() => {
    stackNav.setOptions({ headerShown: !navActive });
  }, [navActive, stackNav]);

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
  // Persistent SNAPSHOT of the selected parking (the full OsmParking object), so
  // the selected marker + zone can be rendered from it even if a small camera
  // move re-clusters it or pushes it out of the viewport result (Bug 2). Single
  // source of truth; the id is derived, never stored separately.
  const [selectedParking, setSelectedParking] = useState<OsmParking | null>(null);
  const selectedParkingId = selectedParking?.id ?? null;
  const [activeRoute,         setActiveRoute]         = useState(false);
  const [routeInfo,           setRouteInfo]           = useState<RouteInfo | null>(null);
  const [routeError,          setRouteError]          = useState<string | null>(null);
  const [osrmPolyline,        setOsrmPolyline]        = useState<LatLng[] | null>(null);
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(null);
  const [userLocation,        setUserLocation]        = useState<LatLng | null>(null);
  const [locationDenied,      setLocationDenied]      = useState(false);

  // Parking is rendered only after "Search Parking" is tapped, and ONLY inside
  // the zones that were searched. `searchZones` ACCUMULATES each searched
  // viewport bbox, so previously found parkings stay on the map when you search
  // a new area (they are not replaced), while results stay scoped to the zones
  // you actually searched instead of the whole city. Panning/zooming never
  // clears them.
  const [searchZones, setSearchZones] = useState<BBox[]>([]);

  // Closest known parking area to the driver — see the throttled scan effect below.
  const [nearestParking, setNearestParking] = useState<{
    parking:        OsmParking;
    distanceMeters: number;
  } | null>(null);
  const suggestionScanRef = useRef<{ at: LatLng; parkings: OsmParking[] } | null>(null);

  // ── Keyboard state ─────────────────────────────────────────────────────────────
  const [keyboardHeight, setKeyboardHeight] = useState(0);

  // Transient English hint shown under the Search Parking button (e.g. when the
  // camera is zoomed too far out to search) — BUG 8.
  const [searchHint, setSearchHint] = useState<string | null>(null);

  // ── Car tracking + navigation camera ─────────────────────────────────────────
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const routeCoords = nav.route?.points ?? NO_COORDS;

  const car = useCarTracking(nav.location, routeCoords, navActive);
  const routeSplit = useRouteProgress(routeCoords, car.matchedLocation);

  // Simplify the full OSRM route for RENDERING only (matching still uses the
  // full-detail routeCoords). Hundreds of overview points make Google drop the
  // polyline at far zoom and during camera animations — a simplified line
  // renders reliably everywhere. `routeKey` changes when the route changes, so a
  // reroute fully remounts the polylines (no leftover old line on native).
  const renderRoute = React.useMemo(
    () => (nav.route ? simplifyCoords(nav.route.points, 5) : NO_COORDS),
    [nav.route],
  );
  const routeKey = nav.route
    ? `${nav.route.points.length}:${Math.round(nav.route.totalDistanceMeters)}`
    : 'none';

  const mapLayout = React.useMemo(
    () => ({
      width:               windowWidth,
      height:              windowHeight,
      topOverlayHeight:    NAV_TOP_CARD_HEIGHT,
      bottomOverlayHeight: NAV_BOTTOM_BAR_HEIGHT,
      safeAreaTop:         insets.top,
      safeAreaBottom:      insets.bottom,
    }),
    [windowWidth, windowHeight, insets.top, insets.bottom],
  );

  const camera = useNavigationCamera({
    mapRef,
    layout:                mapLayout,
    carPosition:           car.carPosition,
    carBearing:            car.carBearing,
    matchedSegmentBearing: car.matchedLocation?.bearing ?? null,
    routeCoordinates:      routeCoords,
    navigationActive:      navActive,
    gpsBearing:            nav.location?.bearingDegrees ?? null,
    speedMps:              nav.location?.speedMps ?? null,
  });

  // ── Free/paid filter ─────────────────────────────────────────────────────────
  // Drives which OSM markers/clusters render. "Free Only" hides paid spots from
  // the map (and clustering) but never deletes them from the cache.
  const filterOnlyFree = useParkingStore((s) => s.filterOnlyFree);

  // Show parking that lies inside ANY searched zone, then apply the free/paid
  // filter. Union of accumulated zones → previously found parkings stay; results
  // stay scoped to searched areas (not the whole city). Source/cache untouched.
  const parkingVisible = searchZones.length > 0;
  const visibleParkings = React.useMemo(() => {
    if (searchZones.length === 0) return EMPTY_PARKINGS;
    const inArea = parkings.filter((p) =>
      searchZones.some(
        (b) =>
          p.position.latitude  >= b.south && p.position.latitude  <= b.north &&
          p.position.longitude >= b.west  && p.position.longitude <= b.east,
      ),
    );
    return filterOnlyFree ? inArea.filter((p) => !isPaidParking(p.tags)) : inArea;
  }, [searchZones, parkings, filterOnlyFree]);

  // ── Parking rendered on the map ───────────────────────────────────────────────
  // During ACTIVE NAVIGATION we render NO parking markers/clusters/zones (like
  // Google/Apple Maps hide POIs in turn-by-turn). This keeps the guidance view
  // clean and stops the follow-camera from re-clustering thousands of points on
  // every GPS tick (the old flicker/slippage/jank). Only route + arrow +
  // destination pin render while driving.
  const parkingForMap  = navActive ? EMPTY_PARKINGS : visibleParkings;
  const selectedForMap = navActive ? null : selectedParking;

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
    // Skip entirely during navigation — the suggestion card is hidden then, and
    // scanning thousands of spots on every GPS move would waste CPU mid-drive.
    if (navActive || !userLocation) {
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
  }, [navActive, userLocation, visibleParkings]);

  // Once parking is displayed AND the camera is close enough to show zone
  // outlines, fetch full ring geometry for the on-screen zones that don't have
  // it yet — in one batched request. Gated by parkingVisible so it never fires
  // while markers are hidden (no display = no geometry pulls). Iterates the
  // filtered `visibleParkings` so paid zones aren't fetched while on Free Only.
  useEffect(() => {
    // No parking is drawn during navigation, so never pull zone geometry then.
    if (navActive || !parkingVisible || !showZonePolygons) return;
    const visibleIds = visibleParkings
      .filter(p =>
        !p.polygon && !p.polyline &&
        p.position.latitude  >= viewportBounds.south && p.position.latitude  <= viewportBounds.north &&
        p.position.longitude >= viewportBounds.west  && p.position.longitude <= viewportBounds.east,
      )
      .map(p => p.id);
    if (visibleIds.length) loadZoneGeometry(visibleIds);
  }, [navActive, parkingVisible, showZonePolygons, visibleParkings, viewportBounds, loadZoneGeometry]);

  // Free Only just hid the selected paid parking — clear its selection, geometry
  // and any route targeting it so nothing points at a spot that's no longer
  // renderable (the stale selected-id + geometry was the filter-toggle crash).
  // Source data/cache is untouched; toggling back to All Parking restores it.
  // Looks the spot up in the FULL source `parkings`, since by now it's already
  // been filtered out of `visibleParkings`.
  useEffect(() => {
    if (!filterOnlyFree || !selectedParking) return;
    if (!isPaidParking(selectedParking.tags)) return; // snapshot carries the tags
    setSelectedParking(null);
    clearGeometry();
    setSelectedDestination(prev =>
      prev && prev.type === 'parking' && prev.id === selectedParkingId ? null : prev);
    osrmFetchIdRef.current++;
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
  }, [filterOnlyFree, selectedParking, selectedParkingId, clearGeometry]);

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
    // Parking display is scoped to the captured search zone and is intentionally
    // NOT cleared on pan/zoom, so the searched parkings never vanish when the map
    // moves. A fresh "Search Parking" press re-scopes to the new viewport.
    //
    // Let the nav camera decide if this was a genuine user gesture (→ free mode).
    camera.handleRegionChangeComplete();
  }, [camera.handleRegionChangeComplete]);

  // Manual parking fetch + display for the current viewport — the ONLY path
  // that pulls new Overpass data and the ONLY thing that reveals markers.
  // loadForRegion keeps its own debounce/coverage/cooldown guards, so repeated
  // taps over an already-loaded area are cheap no-ops (no request storm).
  const handleSearchParking = useCallback(() => {
    // Capture the EXACT current viewport at press time: zoom and region come
    // from lastRegionRef, updated on every onRegionChangeComplete.
    const region = lastRegionRef.current;
    const zoom = deltaToZoom(region.latitudeDelta);
    if (zoom < PARKING_MIN_VISIBLE_ZOOM) {
      // Too far out — don't pull a city/country-wide result set.
      setSearchHint('Zoom in to search this area.');
      return;
    }
    // Deterministic tile guard: a viewport spanning too many data tiles is too
    // large to fetch/render sensibly — ask the user to zoom in instead of
    // pulling thousands of objects.
    const bbox  = regionToBBox(region);
    const tiles = getVisibleTileIds(bbox, getParkingDataZoom(zoom));
    if (tiles.length === 0 || tiles.length >= MAX_TILES_PER_VIEWPORT) {
      setSearchHint('Zoom in to search this area.');
      return;
    }
    console.log('[MapScreen] Search Parking pressed:', tiles.length, 'tiles, zoom', zoom);
    setSearchHint(null);
    // Accumulate this viewport as a new search zone (keeping earlier finds).
    setSearchZones((prev) => {
      const next = regionToBBox(region);
      if (prev.some((b) => bboxContains(b, next))) return prev;     // already covered
      const kept = prev.filter((b) => !bboxContains(next, b));      // drop now-subsumed
      return [...kept, next].slice(-MAX_SEARCH_ZONES);
    });
    loadForRegion(region);
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
    setSelectedParking(null);
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    clearGeometry();
  }, [clearGeometry]);

  // Long-press: drops a pin, sets it as navigation destination, reverse-geocodes address.
  const handleLongPress = useCallback(async (e: LongPressEvent) => {
    setSearchPin(null);
    setSelectedParking(null);
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
      setSelectedParking(null);
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

    // Already navigating? Tapping a parking immediately re-routes to it — no
    // need to leave navigation to pick the next destination.
    if (nav.isActive) {
      console.log('[MapScreen] reroute to tapped parking during navigation:', parking.id);
      nav.start(parking.position);
      return;
    }

    console.log('[MapScreen] parking marker tapped:', parking.id);

    const dest: SelectedDestination = {
      id:       parking.id,
      type:     'parking',
      title:    parking.tags.name ?? parking.tags['name:en'] ?? parking.tags['name:ru'] ?? 'Parking',
      position: parking.position,
    };
    setSelectedParking(parking);
    setSelectedDestination(dest);
    setActiveRoute(false);
    setRouteInfo(null);
    setRouteError(null);
    setOsrmPolyline(null);
    loadGeometry(parking);

    console.log('[MapScreen] navigation sheet opening for parking:', dest.title);
  }, [loadGeometry, nav]);

  // Long-press WHILE navigating → drop a new destination and reroute instantly,
  // so the driver can chain to a next stop without leaving navigation.
  const handleNavLongPress = useCallback((e: LongPressEvent) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    console.log('[MapScreen] reroute to long-press point during navigation:', latitude, longitude);
    nav.start({ latitude, longitude });
  }, [nav]);

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
  // "Start Route" launches full in-app turn-by-turn navigation (OSRM route +
  // voice + reroute) via the navigation hook — it owns location acquisition,
  // route building and the live guidance state machine. The old static route
  // preview is superseded by this richer flow.
  const handleStartRoute = useCallback(() => {
    if (!selectedDestination) return;
    console.log('[MapScreen] Start Route pressed for:', selectedDestination.title);
    nav.start(selectedDestination.position);
  }, [selectedDestination, nav]);

  // Re-attempt navigation to the same destination after a recoverable error.
  const handleRetryNavigation = useCallback(() => {
    if (nav.destination) nav.start(nav.destination);
  }, [nav]);

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
    setSelectedParking(null);
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
        showsUserLocation={!navActive}
        showsMyLocationButton={false}
        onLongPress={navActive ? handleNavLongPress : handleLongPress}
        onPress={navActive ? undefined : handleMapPress}
        onPanDrag={navActive ? camera.enterFreeMode : undefined}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        mapPadding={navActive ? camera.mapPadding : { top: 120, right: 0, bottom: 0, left: 0 }}
      >
        {/* OSM parking clusters/markers + selected zone. Hidden entirely during
            active navigation (parkingForMap / selectedForMap go empty) so the
            guidance view stays clean and the follow-camera never re-clusters. */}
        <ParkingLayer
          parkings={parkingForMap}
          selectedParking={selectedForMap}
          latitudeDelta={latDelta}
          viewportBounds={viewportBounds}
          onPressMarker={handlePressParkingZone}
          onPressCluster={handlePressCluster}
          selectedPolygon={geometry?.polygon ?? null}
          selectedPolyline={geometry?.polyline ?? null}
          showZonePolygons={showZonePolygons}
        />

        {/* ── Active turn-by-turn navigation overlays ─────────────────────────── */}
        {/* Premium layered route (casing + accent + highlight) with a muted
            completed trail behind the arrow. Split memoized in useRouteProgress. */}
        {navActive && nav.route && (
          <NavigationRoute
            key={routeKey}
            route={renderRoute}
            completed={routeSplit.completed}
          />
        )}
        {/* Red destination pin — marks where the driver is heading (parking is
            hidden during navigation, so this is the only destination marker). */}
        {navActive && nav.destination && (
          <Marker
            // Key by coordinate so a reroute remounts the pin at the new point
            // (and it re-rasterises), fixing the "tapped point disappears" case.
            key={`nav-dest-${nav.destination.latitude.toFixed(5)},${nav.destination.longitude.toFixed(5)}`}
            coordinate={nav.destination}
            anchor={{ x: 0.5, y: 1 }}
          >
            <CustomPinView color="#EF4444" />
          </Marker>
        )}
        {/* Single premium navigation arrow — smooth movement (AnimatedRegion) +
            rotation. Rendered once the first fix arrives; updated in place. */}
        {navActive && car.carPosition && (
          <NavigationArrow coordinate={car.animatedCoordinate} rotation={car.rotation} />
        )}

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
              {/* Text only — never a spinner inside a Marker/Callout. While
                  reverse-geocoding, `address` already reads "Searching…". */}
              <View style={styles.callout}>
                <Text style={styles.calloutText}>{droppedPin.address}</Text>
                {!droppedPin.loading && (
                  <Text style={styles.coordsText}>
                    {droppedPin.latitude.toFixed(6)}, {droppedPin.longitude.toFixed(6)}
                  </Text>
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

      {/* Map-browsing UI — hidden entirely while turn-by-turn navigation runs
          (the NavigationPanel owns the screen then). */}
      {!navActive && (
        <>
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
            {searchHint && (
              <View style={styles.searchHintBox}>
                <Text style={styles.searchHintText}>{searchHint}</Text>
              </View>
            )}
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
        </>
      )}

      {/* Floating recenter button — only in free mode; restores following, car
          below centre, road ahead up. Sits above the bottom trip bar + safe area. */}
      {navActive && camera.cameraMode === 'free' && (
        <NavigationRecenterButton
          onPress={camera.recenter}
          bottom={insets.bottom + NAV_BOTTOM_BAR_HEIGHT + 24}
        />
      )}

      {/* Turn-by-turn navigation overlay (top banner + trip bar + status/errors) */}
      <NavigationPanel
        state={nav.state}
        onStop={nav.stop}
        onToggleMute={nav.toggleMute}
        onRecenter={camera.recenter}
        onRetry={handleRetryNavigation}
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
    top: 8,
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
    top: 62,
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
  searchHintBox: {
    marginTop: 8,
    backgroundColor: "#FEF3C7",
    borderRadius: 12,
    paddingVertical: 8,
    paddingHorizontal: 12,
  },
  searchHintText: { color: "#92400E", fontSize: 13, fontWeight: "600", textAlign: "center" },
  nearbySuggestionWrapper: {
    position: "absolute",
    top: 116,
    left: 16,
    right: 16,
    zIndex: 70,
  },
  legendContainer: { position: "absolute", bottom: 260, left: 15 },
  navArrow: {
    width: 34, height: 34, borderRadius: 17,
    backgroundColor: "#007AFF", borderWidth: 3, borderColor: "#ffffff",
    alignItems: "center", justifyContent: "center",
  },
  navArrowGlyph: { color: "#ffffff", fontSize: 16, fontWeight: "900", marginTop: -1 },
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
