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
  LongPressEvent,
  Region,
} from "react-native-maps";
import { useWindowDimensions } from "react-native";
import * as Location from "expo-location";
import { useNavigation as useStackNavigation } from "@react-navigation/native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { FilterToggle } from "../components/FilterToggle";
import { SearchBar } from "../components/SearchBar";
import { ParkingLayer } from "../components/ParkingLayer";
import { GeometryLoadingBar } from "../components/GeometryLoadingBar";
import { RouteBottomSheet, SHEET_HEIGHT } from "../components/RouteBottomSheet";
import { NearbyParkingSuggestion } from "../components/NearbyParkingSuggestion";
import { NavigationPanel } from "../components/NavigationPanel";
import { NavigationArrow } from "../components/NavigationArrow";
import { NavigationRoute } from "../components/NavigationRoute";
import { NavigationRecenterButton } from "../components/NavigationRecenterButton";
import { AppIcon } from "../components/AppIcon";
import { useMapParkings } from "../hooks/useMapParkings";
import { useGeometryLoader } from "../hooks/useGeometryLoader";
import { useNavigation } from "../hooks/useNavigation";
import { useCarTracking } from "../hooks/useCarTracking";
import { useRouteProgress } from "../hooks/useRouteProgress";
import { useNavigationCamera } from "../hooks/useNavigationCamera";
import { useParkingStore } from "../store/useParkingStore";
import { OsmParking, LatLng, BBox, RouteInfo, SelectedDestination } from "../types/parking";
import { haversineDistance, deltaToZoom, simplifyCoords } from "../utils/geo";
import { isFreeParking, parkingFeeStatus, parkingName } from "../utils/parking";
import {
  ParkingAccessCandidate,
  ParkingAccessSource,
  classifyParkingGeometry,
  resolveParkingRouteTarget,
} from "../utils/parkingAccess";
import {
  ParkingAccessContext,
  fetchParkingAccessContext,
} from "../services/overpassService";
import {
  LOD_MEDIUM_MIN_ZOOM,
  ParkingLod,
  getParkingLod,
  zoomFromDelta,
} from "../constants/parkingLod";
import {
  getVisibleTileIds,
  getParkingDataZoom,
  MAX_TILES_PER_VIEWPORT,
} from "../services/parking/parkingTiles";
import { fetchOsrmRoute } from "../services/navigation/osrmNavigation";
import type { NavigationRoute as NavigationRouteModel } from "../types/navigation";

export const MALAGA_REGION = {
  latitude: 36.7213,
  longitude: -4.4214,
  latitudeDelta: 0.09,
  longitudeDelta: 0.06,
};

const RECENTER_BOTTOM_DEFAULT    = 40;
const RECENTER_LIFT_MARGIN       = 12;
const NEARBY_SUGGESTION_RADIUS_M = 1_500;
const SUGGESTION_RECOMPUTE_THRESHOLD_M = 80;
const PARKING_ACCESS_LOOKUP_TIMEOUT_MS = 5_000;
// Below this zoom, parking markers hide entirely (Google-Maps-like) — even
// when display is enabled. Matches the fetch threshold (useMapParkings MIN_ZOOM)
// and the default MALAGA_REGION view (~zoom 12) so a Search Parking press from
// the initial camera actually reveals markers; clustering keeps city-zoom dense
// areas to a handful of bubbles, so this is safe without going higher.
const PARKING_MIN_VISIBLE_ZOOM   = 12;

// Stable empty array so gating parking off doesn't allocate a new reference
// every render (which would thrash the Supercluster index memo downstream).
const EMPTY_PARKINGS: OsmParking[] = [];
// Stable map padding for browsing. A NEW object literal each render made
// react-native-maps re-apply padding on every re-render; on iOS Google Maps
// that repeatedly reconfigures the map and drops the native blue "my location"
// dot (the "disappears after a few Search Parking presses" bug). A constant
// reference means the native map is never reconfigured by unrelated re-renders.
const BROWSING_MAP_PADDING = { top: 120, right: 0, bottom: 0, left: 0 };
// Reduce built-in POI noise while preserving road/place labels needed for
// orientation. FreePark's own parking layer remains the visual focus.
const CLEAN_MAP_STYLE: NonNullable<React.ComponentProps<typeof MapView>['customMapStyle']> = [
  { featureType: 'poi', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
  { featureType: 'poi.business', elementType: 'labels.text', stylers: [{ visibility: 'off' }] },
  { featureType: 'transit.station', elementType: 'labels.icon', stylers: [{ visibility: 'off' }] },
];
// Window (ms) after a marker tap during which a map-press for the SAME physical
// tap (iOS fires both) is ignored — deterministic, unlike frame timing.
const MARKER_TAP_GUARD_MS = 350;
// Stable empty route coords for the car-tracking hook when not navigating.
const NO_COORDS: LatLng[] = [];

type RoutePreviewState =
  | { kind: 'idle' }
  | { kind: 'building'; destinationId: string }
  | {
      kind: 'ready';
      revision: number;
      destinationId: string;
      destination: LatLng;
      origin: LatLng;
      route: NavigationRouteModel;
      routeInfo: RouteInfo;
    }
  | { kind: 'error'; destinationId: string; message: string };

const IDLE_ROUTE_PREVIEW: RoutePreviewState = { kind: 'idle' };

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

function parkingAccessLabel(source: ParkingAccessSource): string {
  switch (source) {
    case 'polygon-center':
      return 'Route to parking zone center';
    case 'explicit-entrance':
      return 'Route to mapped vehicle entrance';
    case 'service-intersection':
      return 'Route to parking driveway';
    case 'service-nearest':
      return 'Route to nearest driveway access';
    case 'street-endpoint':
      return 'Route to start of parking segment';
    case 'boundary-fallback':
      return 'Route to nearest parking boundary';
    default:
      return 'Route to mapped parking point';
  }
}

export const MapScreen: React.FC = () => {
  // ── OSM parking zone hooks ───────────────────────────────────────────────────
  const {
    parkings,
    loading,
    zoneGeometryLoading,
    fetchError,
    loadForRegion,
    loadZoneGeometry,
  } = useMapParkings();
  const { geometry, geometryLoading, loadGeometry, clearGeometry } = useGeometryLoader();

  // ── Turn-by-turn navigation (OSRM + expo-location + expo-speech) ─────────────
  const nav = useNavigation();
  const navActive = nav.isActive;
  const carTrackingActive = nav.state.kind === 'navigating';
  // Live mirror of `nav` so the stable marker-tap handler can read it without
  // taking `nav` as a dependency (which would recreate the handler each render).
  const navRef = useRef(nav);
  navRef.current = nav;

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
  // Timestamp of the last marker tap — a deterministic window (MARKER_TAP_GUARD_MS)
  // so the map-press for the same physical tap can't cancel a fresh selection even
  // if it arrives a frame or two late (the old requestAnimationFrame flag raced it).
  const markerTapAtRef      = useRef(0);
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
  const routePreviewAbortRef = useRef<AbortController | null>(null);
  const parkingAccessRequestRef = useRef(0);
  const parkingAccessAbortRef = useRef<AbortController | null>(null);
  const navigationStartPendingRef = useRef(false);
  const parkingAccessContextRef = useRef<{
    parkingId: string;
    context: ParkingAccessContext;
  } | null>(null);
  const userLocationRef = useRef<LatLng | null>(null);

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
  // Parking-zone Level of Detail for the settled camera — updated only on
  // onRegionChangeComplete (not per frame) with hysteresis so a zoom hovering on
  // a threshold doesn't flicker. Drives ParkingLayer's geometry rendering and
  // the on-demand geometry fetch. See constants/parkingLod.
  const [lod,               setLod]               = useState<ParkingLod>('low');
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
  // Live mirror so the stable marker-tap handler can detect a re-tap on the
  // already-selected parking (toggle-off) without depending on selection state.
  const selectedParkingIdRef = useRef<string | null>(null);
  selectedParkingIdRef.current = selectedParkingId;
  const [routePreview, setRoutePreview] = useState<RoutePreviewState>(IDLE_ROUTE_PREVIEW);
  const [selectedDestination, setSelectedDestination] = useState<SelectedDestination | null>(null);
  const [userLocation,        setUserLocation]        = useState<LatLng | null>(null);
  const [locationDenied,      setLocationDenied]      = useState(false);
  const [selectedParkingAccess, setSelectedParkingAccess] =
    useState<ParkingAccessCandidate | null>(null);
  const [parkingAccessLoading, setParkingAccessLoading] = useState(false);
  userLocationRef.current = nav.location?.position ?? userLocation;

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

  // A failed/rate-limited region fetch previously only logged a console.warn —
  // "Search this area" went quiet with no new markers and no feedback,
  // indistinguishable from "we searched and there's genuinely nothing here".
  // Surface it through the same hint pill so a real failure is visible.
  useEffect(() => {
    if (fetchError) setSearchHint(fetchError);
  }, [fetchError]);

  // ── Car tracking + navigation camera ─────────────────────────────────────────
  const insets = useSafeAreaInsets();
  const { width: windowWidth, height: windowHeight } = useWindowDimensions();
  const routeCoords = nav.route?.points ?? NO_COORDS;
  const navigationEndpoint = nav.route && nav.route.points.length > 0
    ? nav.route.points[nav.route.points.length - 1]
    : nav.destination;

  const car = useCarTracking(nav.location, routeCoords, carTrackingActive);
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
  const previewRenderRoute = React.useMemo(
    () => routePreview.kind === 'ready'
      ? simplifyCoords(routePreview.route.points, 5)
      : NO_COORDS,
    [routePreview],
  );
  const routeKey = `nav-route-${nav.routeRevision}`;

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
    navigationSessionRevision: nav.sessionRevision,
    gpsBearing:            nav.location?.bearingDegrees ?? null,
    speedMps:              nav.location?.speedMps ?? null,
    distanceToNextManeuverMeters:
      nav.state.kind === 'navigating' ? nav.state.distanceToNextManeuverMeters : null,
  });

  const handleNavigationPanDrag = useCallback(() => {
    camera.enterFreeMode();
    navRef.current.setFollowing(false);
  }, [camera.enterFreeMode]);

  const handleNavigationRecenter = useCallback(() => {
    camera.recenter();
    navRef.current.recenter();
  }, [camera.recenter]);

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
    return filterOnlyFree ? inArea.filter((p) => isFreeParking(p.tags)) : inArea;
  }, [searchZones, parkings, filterOnlyFree]);

  // ── Parking rendered on the map ───────────────────────────────────────────────
  // During ACTIVE NAVIGATION we render NO parking markers/clusters/zones (like
  // Google/Apple Maps hide POIs in turn-by-turn). This keeps the guidance view
  // clean and stops the follow-camera from re-clustering thousands of points on
  // every GPS tick (the old flicker/slippage/jank). Only route + arrow +
  // destination pin render while driving.
  //
  // The same declutter applies once a route PREVIEW is being built/shown: with
  // parking markers/zone outlines left on, the selected zone's own blue outline
  // (and any nearby paid zone's orange outline) visually tangles with the route
  // polyline — that was the "looks very bad" clutter. Good map apps hide POIs
  // the moment a route is requested and show only origin + destination + line.
  const previewingRoute =
    !navActive && (routePreview.kind === 'building' || routePreview.kind === 'ready');
  const parkingForMap  = navActive || previewingRoute ? EMPTY_PARKINGS : visibleParkings;
  const selectedForMap = navActive || previewingRoute ? null : selectedParking;

  const canNavigate = true;

  const recenterLift = Math.max(
    keyboardHeight      > 0 ? keyboardHeight   + RECENTER_LIFT_MARGIN : 0,
    selectedDestination     ? SHEET_HEIGHT     + RECENTER_LIFT_MARGIN : 0,
  );
  const recenterBottom = recenterLift > 0 ? recenterLift : RECENTER_BOTTOM_DEFAULT;

  const showNearbySuggestion =
    !!nearestParking && !selectedDestination && !searchPin && !droppedPin && keyboardHeight === 0;

  // ── Effects ───────────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!navActive && droppedPin && !droppedPin.loading) {
      const t = setTimeout(() => droppedMarkerRef.current?.showCallout(), 400);
      return () => clearTimeout(t);
    }
  }, [navActive, droppedPin?.id, droppedPin?.loading]);

  useEffect(() => {
    if (!navActive && searchPin) {
      const t = setTimeout(() => searchMarkerRef.current?.showCallout(), 500);
      return () => clearTimeout(t);
    }
  }, [navActive, searchPin]);

  useEffect(() => () => {
    osrmFetchIdRef.current++;
    routePreviewAbortRef.current?.abort();
    parkingAccessRequestRef.current++;
    parkingAccessAbortRef.current?.abort();
  }, []);

  // Location permission + live tracking for routing. Grabs a fast one-shot fix
  // via getCurrentPositionAsync FIRST (watchPositionAsync can take many seconds
  // to emit its first sample — that lag was the "Waiting for location…" the
  // bottom sheet got stuck on), then subscribes for live updates.
  useEffect(() => {
    // Turn-by-turn owns a BestForNavigation watcher. Do not keep a second native
    // subscription alive in parallel; browsing tracking resumes after End.
    if (navActive) return;
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
      const nextSub = await Location.watchPositionAsync(
        { accuracy: Location.Accuracy.Balanced, distanceInterval: 10 },
        (loc) => {
          if (cancelled) return;
          setUserLocation({ latitude: loc.coords.latitude, longitude: loc.coords.longitude });
        },
      );
      if (cancelled) {
        nextSub.remove();
      } else {
        sub = nextSub;
      }
    })().catch(() => {
      // Permission/location APIs can reject during backgrounding or teardown.
    });
    return () => { cancelled = true; sub?.remove(); };
  }, [navActive]);

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

  const handleBrowseRecenter = useCallback(async () => {
    const location = userLocation ?? await ensureUserLocation();
    mapRef.current?.animateToRegion(
      location
        ? { ...location, latitudeDelta: 0.01, longitudeDelta: 0.01 }
        : MALAGA_REGION,
      650,
    );
  }, [ensureUserLocation, userLocation]);

  const clearRoutePreview = useCallback(() => {
    osrmFetchIdRef.current++;
    routePreviewAbortRef.current?.abort();
    routePreviewAbortRef.current = null;
    setRoutePreview(IDLE_ROUTE_PREVIEW);
  }, []);

  // Single source of truth for clearing the current parking/destination
  // selection and any route state built for it. One stable helper used by the
  // map-press, the close control, the re-tap toggle, the filter and the
  // "selection no longer exists" guard — so the selected marker, selected zone,
  // selected paid parking and the info sheet can never drift out of sync.
  const clearSelection = useCallback(() => {
    clearRoutePreview();
    parkingAccessRequestRef.current++;
    parkingAccessAbortRef.current?.abort();
    parkingAccessAbortRef.current = null;
    parkingAccessContextRef.current = null;
    setSelectedParking(null);
    setSelectedDestination(null);
    setSelectedParkingAccess(null);
    setParkingAccessLoading(false);
    clearGeometry();
  }, [clearGeometry, clearRoutePreview]);

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

  // Once parking is displayed AND the LOD calls for zone outlines (medium/high),
  // fetch full ring geometry for the on-screen zones that don't have it yet — in
  // one batched request. Gated by parkingVisible so it never fires while markers
  // are hidden (no display = no geometry pulls). Iterates the filtered
  // `visibleParkings` so paid zones aren't fetched while on Free Only.
  useEffect(() => {
    // Prefetch shortly before the visual switch so users never zoom into an
    // empty map. The existing LOD hysteresis keeps the actual mode stable.
    const shouldPrefetch = zoomFromDelta(latDelta) >= LOD_MEDIUM_MIN_ZOOM - 0.6;
    if (navActive || !parkingVisible || !shouldPrefetch) return;
    const visibleIds = visibleParkings
      .filter(p =>
        !p.polygon && !p.polyline &&
        p.position.latitude  >= viewportBounds.south && p.position.latitude  <= viewportBounds.north &&
        p.position.longitude >= viewportBounds.west  && p.position.longitude <= viewportBounds.east,
      )
      .map(p => p.id);
    if (visibleIds.length) loadZoneGeometry(visibleIds);
  }, [navActive, parkingVisible, latDelta, visibleParkings, viewportBounds, loadZoneGeometry]);

  // Free Only just hid a paid/unknown parking — clear the whole selection so
  // nothing points at a spot the filter no longer renders (the stale selected-id
  // + geometry was the filter-toggle crash). Source data/cache is untouched;
  // toggling back to All Parking simply lets it be re-selected.
  useEffect(() => {
    if (!filterOnlyFree || !selectedParking) return;
    if (isFreeParking(selectedParking.tags)) return; // snapshot carries the tags
    clearSelection();
  }, [filterOnlyFree, selectedParking, clearSelection]);

  // Guard: if the selected parking is no longer present in the canonical dataset
  // (e.g. the parking cache was cleared), drop the stale selection so the sheet
  // and highlight never reference a spot that doesn't exist anymore.
  useEffect(() => {
    if (!selectedParking) return;
    if (!parkings.some(p => p.id === selectedParking.id)) clearSelection();
  }, [parkings, selectedParking, clearSelection]);

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
  const handleRegionChangeComplete = useCallback((
    region: Region,
    details?: { isGesture?: boolean },
  ) => {
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
    // Recompute the parking-zone LOD from the settled zoom, carrying the previous
    // level so a zoom sitting on a threshold doesn't flip back and forth
    // (hysteresis lives in getParkingLod). Settled-region only — never per frame.
    setLod(prev => getParkingLod(region.latitudeDelta, prev));
    // Parking display is scoped to the captured search zone and is intentionally
    // NOT cleared on pan/zoom, so the searched parkings never vanish when the map
    // moves. A fresh "Search Parking" press re-scopes to the new viewport.
    //
    // Let the nav camera decide if this was a genuine user gesture (→ free mode).
    camera.handleRegionChangeComplete(details?.isGesture);
    if (details?.isGesture === true && navActive) {
      navRef.current.setFollowing(false);
    }
  }, [camera.handleRegionChangeComplete, navActive]);

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

  // Map tap on an empty area: clears the selection, pins and route state.
  // Ignores the map-press that iOS fires for the SAME physical tap as a marker
  // press — both the immediate flag and a deterministic time window, so a
  // fresh selection can't be cancelled by its own tap (Problem 4).
  const handleMapPress = useCallback(() => {
    if (markerJustTappedRef.current || Date.now() - markerTapAtRef.current < MARKER_TAP_GUARD_MS) return;
    setDroppedPin(null);
    setSearchPin(null);
    clearSelection();
  }, [clearSelection]);

  // Long-press: drops a pin, sets it as navigation destination, reverse-geocodes address.
  const handleLongPress = useCallback(async (e: LongPressEvent) => {
    clearSelection();
    setSearchPin(null);

    const { latitude, longitude } = e.nativeEvent.coordinate;
    const newId      = Date.now();
    const pinId      = `pin-${newId}`;
    const position   = { latitude, longitude };
    const coordTitle = `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`;

    console.log('[MapScreen] long-press pin placed at:', coordTitle);

    setDroppedPin({ id: newId, latitude, longitude, loading: true, address: 'Searching…' });
    setSelectedDestination({ id: pinId, type: 'pin', title: coordTitle, position });

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
  }, [clearSelection]);

  // Search result selected: places a pin, sets navigation destination, animates camera.
  const handleLocationSelect = useCallback(
    (lat: number, lon: number, addr?: string) => {
      const title = addr || 'Selected Point';
      console.log('[MapScreen] search result selected:', title);

      clearSelection();
      setDroppedPin(null);
      setSearchPin({ latitude: lat, longitude: lon, address: title });
      setSelectedDestination({
        id:       `search-${lat}-${lon}`,
        type:     'search',
        title,
        position: { latitude: lat, longitude: lon },
      });
      mapRef.current?.animateToRegion(
        { latitude: lat, longitude: lon, latitudeDelta: 0.003, longitudeDelta: 0.003 },
        800,
      );
      console.log('[MapScreen] navigation sheet opening for search result');
    },
    [clearSelection],
  );

  // Resolve the route target without blocking selection. Full geometry refines
  // a polygon selection to its exact centre; point objects may still use nearby
  // mapped entrances and driveways.
  const refineParkingAccess = useCallback(async (parking: OsmParking) => {
    const requestId = ++parkingAccessRequestRef.current;
    parkingAccessAbortRef.current?.abort();
    const ctrl = new AbortController();
    parkingAccessAbortRef.current = ctrl;
    parkingAccessContextRef.current = null;
    setParkingAccessLoading(true);

    const applyCandidate = (candidate: ParkingAccessCandidate | null) => {
      if (!candidate || requestId !== parkingAccessRequestRef.current || ctrl.signal.aborted) return;
      setSelectedParkingAccess(candidate);
      setSelectedDestination((current) =>
        current?.type === 'parking' && current.id === parking.id
          ? { ...current, position: candidate.position }
          : current,
      );
    };

    try {
      const loadedGeometry = await loadGeometry(parking);
      if (requestId !== parkingAccessRequestRef.current || ctrl.signal.aborted) return;

      const detailedParking: OsmParking = {
        ...parking,
        polygon: loadedGeometry?.polygon ?? parking.polygon,
        polyline: loadedGeometry?.polyline ?? parking.polyline,
      };
      const reference = userLocationRef.current ?? parking.position;
      applyCandidate(resolveParkingRouteTarget({ ...detailedParking, reference }));

      const geometryKind = classifyParkingGeometry(detailedParking);
      if (geometryKind === 'street' || geometryKind === 'area') return;

      const accessCtrl = new AbortController();
      const abortAccessLookup = () => accessCtrl.abort();
      const accessTimer = setTimeout(
        () => accessCtrl.abort(),
        PARKING_ACCESS_LOOKUP_TIMEOUT_MS,
      );
      ctrl.signal.addEventListener('abort', abortAccessLookup, { once: true });
      try {
        const context = await fetchParkingAccessContext(detailedParking, accessCtrl.signal);
        if (requestId === parkingAccessRequestRef.current && !ctrl.signal.aborted) {
          parkingAccessContextRef.current = { parkingId: parking.id, context };
        }
        applyCandidate(resolveParkingRouteTarget({
          ...detailedParking,
          explicitEntrances: context.entrances,
          serviceWays: context.serviceWays,
          reference: userLocationRef.current ?? reference,
        }));
      } catch (error) {
        if (error instanceof Error && error.name === 'AbortError') return;
        // The local boundary/endpoint remains a usable fallback.
      } finally {
        clearTimeout(accessTimer);
        ctrl.signal.removeEventListener('abort', abortAccessLookup);
      }
    } finally {
      if (requestId === parkingAccessRequestRef.current) {
        parkingAccessAbortRef.current = null;
        setParkingAccessLoading(false);
      }
    }
  }, [loadGeometry]);

  // OSM parking marker (free "P" or paid "€") tapped: selects it and opens the
  // info sheet, re-tapping the selected one toggles it off. Stable identity — it
  // reads nav + the selected id from refs, so it never needs to be recreated
  // (which would otherwise churn every marker/outline that takes it as onPress).
  const handlePressParkingZone = useCallback((parking: OsmParking) => {
    if (isProcessingRef.current || isGesturingRef.current) return;
    isProcessingRef.current = true;
    setTimeout(() => { isProcessingRef.current = false; }, 500);

    // Deterministic guard so the map-press for this same physical tap can't clear
    // the selection we're about to set (Problem 4).
    markerJustTappedRef.current = true;
    markerTapAtRef.current = Date.now();
    requestAnimationFrame(() => { markerJustTappedRef.current = false; });

    const navigation = navRef.current;
    const immediateAccess = resolveParkingRouteTarget({
      ...parking,
      reference: userLocationRef.current ?? parking.position,
    });
    // Already navigating? Tapping a parking immediately re-routes to it — no
    // need to leave navigation to pick the next destination.
    if (navigation.isActive) {
      console.log('[MapScreen] reroute to tapped parking during navigation:', parking.id);
      clearSelection();
      setSearchPin(null);
      setDroppedPin(null);
      navigation.start(immediateAccess?.position ?? parking.position);
      return;
    }

    // Re-tap on the already-selected parking → toggle the selection off.
    if (selectedParkingIdRef.current === parking.id) {
      console.log('[MapScreen] parking re-tapped — clearing selection:', parking.id);
      clearSelection();
      return;
    }

    console.log('[MapScreen] parking marker tapped:', parking.id);

    const dest: SelectedDestination = {
      id:       parking.id,
      type:     'parking',
      title:    parkingName(parking),
      position: immediateAccess?.position ?? parking.position,
    };
    setSelectedParking(parking);
    setSelectedParkingAccess(immediateAccess);
    setSelectedDestination(dest);
    clearRoutePreview();
    void refineParkingAccess(parking);

    console.log('[MapScreen] info sheet opening for parking:', dest.title);
  }, [refineParkingAccess, clearSelection, clearRoutePreview]);

  // Long-press WHILE navigating → drop a new destination and reroute instantly,
  // so the driver can chain to a next stop without leaving navigation.
  const handleNavLongPress = useCallback((e: LongPressEvent) => {
    const { latitude, longitude } = e.nativeEvent.coordinate;
    console.log('[MapScreen] reroute to long-press point during navigation:', latitude, longitude);
    clearSelection();
    setSearchPin(null);
    setDroppedPin(null);
    nav.start({ latitude, longitude });
  }, [clearSelection, nav]);

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
  // Stage one builds and fits the complete route without starting guidance.
  // Stage two reuses that exact route for turn-by-turn navigation.
  const handlePreviewRoute = useCallback(async () => {
    if (!selectedDestination || parkingAccessLoading) return;
    const destination = { ...selectedDestination.position };
    const destinationId = selectedDestination.id;
    const requestId = ++osrmFetchIdRef.current;
    routePreviewAbortRef.current?.abort();
    const ctrl = new AbortController();
    routePreviewAbortRef.current = ctrl;
    setRoutePreview({ kind: 'building', destinationId });

    const origin = userLocation ?? await ensureUserLocation();
    if (requestId !== osrmFetchIdRef.current || ctrl.signal.aborted) return;
    if (!origin) {
      routePreviewAbortRef.current = null;
      setRoutePreview({
        kind: 'error',
        destinationId,
        message: 'Could not determine your location',
      });
      return;
    }

    try {
      const result = await fetchOsrmRoute(origin, destination, ctrl.signal);
      if (requestId !== osrmFetchIdRef.current || ctrl.signal.aborted) return;
      setRoutePreview({
        kind: 'ready',
        revision: requestId,
        destinationId,
        destination,
        origin,
        route: result.navigationRoute,
        routeInfo: result.routeInfo,
      });
      mapRef.current?.fitToCoordinates(result.polyline, {
        edgePadding: {
          top: insets.top + 150,
          bottom: insets.bottom + SHEET_HEIGHT + 32,
          left: 36,
          right: 36,
        },
        animated: true,
      });
    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') return;
      if (requestId !== osrmFetchIdRef.current || ctrl.signal.aborted) return;
      setRoutePreview({
        kind: 'error',
        destinationId,
        message: error instanceof Error ? error.message : 'Route unavailable',
      });
    } finally {
      if (routePreviewAbortRef.current === ctrl) routePreviewAbortRef.current = null;
    }
  }, [
    selectedDestination,
    parkingAccessLoading,
    userLocation,
    ensureUserLocation,
    insets.top,
    insets.bottom,
  ]);

  const handleStartRoute = useCallback(() => {
    if (routePreview.kind !== 'ready' || navigationStartPendingRef.current) return;
    navigationStartPendingRef.current = true;
    const { destination, route } = routePreview;
    clearRoutePreview();
    void nav.startPrepared(destination, route).finally(() => {
      navigationStartPendingRef.current = false;
    });
  }, [routePreview, clearRoutePreview, nav]);

  // Re-attempt navigation to the same destination after a recoverable error.
  const handleRetryNavigation = useCallback(() => {
    if (nav.destination) nav.start(nav.destination);
  }, [nav]);

  const handleCloseSheet = useCallback(() => {
    clearSelection();
    setSearchPin(null);
    setDroppedPin(null);
  }, [clearSelection]);

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
        customMapStyle={CLEAN_MAP_STYLE}
        initialRegion={MALAGA_REGION}
        showsUserLocation={!carTrackingActive || !car.carPosition}
        showsMyLocationButton={false}
        onLongPress={navActive ? handleNavLongPress : handleLongPress}
        onPress={navActive ? undefined : handleMapPress}
        onPanDrag={navActive ? handleNavigationPanDrag : undefined}
        onRegionChange={handleRegionChange}
        onRegionChangeComplete={handleRegionChangeComplete}
        // Stable reference while browsing (BROWSING_MAP_PADDING) — a fresh object
        // each render made iOS Google Maps re-apply padding and drop the native
        // user-location dot after a few searches (Problem 3).
        mapPadding={navActive ? camera.mapPadding : BROWSING_MAP_PADDING}
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
          lod={lod}
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
        {navActive && navigationEndpoint && (
          <Marker
            // Key by coordinate so a reroute remounts the pin at the new point
            // (and it re-rasterises), fixing the "tapped point disappears" case.
            key={`nav-dest-${navigationEndpoint.latitude.toFixed(5)},${navigationEndpoint.longitude.toFixed(5)}`}
            coordinate={navigationEndpoint}
            anchor={{ x: 0.5, y: 1 }}
          >
            <CustomPinView color="#EF4444" />
          </Marker>
        )}
        {/* Single premium navigation arrow — smooth movement (AnimatedRegion) +
            rotation. Rendered once the first fix arrives; updated in place. */}
        {carTrackingActive && car.carPosition && (
          <NavigationArrow
            key={`nav-car-${nav.routeRevision}`}
            coordinate={car.animatedCoordinate}
            rotation={car.rotation}
          />
        )}

        {/* Full preview stays in browsing mode until the user explicitly starts. */}
        {!navActive && routePreview.kind === 'ready' && (
          <NavigationRoute
            key={`preview-route-${routePreview.destinationId}-${routePreview.revision}`}
            route={previewRenderRoute}
            completed={NO_COORDS}
          />
        )}

        {/* Destination pin for a previewed PARKING route. Parking markers/zones
            are hidden while previewingRoute (see parkingForMap/selectedForMap
            above), so this is the only marker for that destination — matching
            the clean origin-dot + destination-pin look of mainstream map apps.
            Search/dropped-pin destinations already render their own pin below,
            so this only covers the 'parking' case to avoid a duplicate. */}
        {previewingRoute && selectedDestination?.type === 'parking' && (
          <Marker
            key={`preview-dest-${selectedDestination.id}`}
            coordinate={selectedDestination.position}
            anchor={{ x: 0.5, y: 1 }}
            zIndex={15}
          >
            <CustomPinView color="#EF4444" />
          </Marker>
        )}

        {/* Search result pin */}
        {!navActive && searchPin && (
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
        {!navActive && droppedPin && (
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
      <GeometryLoadingBar visible={geometryLoading || zoneGeometryLoading || loading} />
      {/* Map-browsing UI — hidden entirely while turn-by-turn navigation runs
          (the NavigationPanel owns the screen then). */}
      {/* Search chrome — hidden while a route is being previewed/built so the
          map stays focused on origin → destination, the same way mainstream
          map apps collapse search UI once directions are requested. The
          RouteBottomSheet's close (X) brings it back. */}
      {!navActive && !previewingRoute && (
        <>
          {/* Header: search bar + free/all filter toggle */}
          <View style={styles.headerWrapper}>
            <View style={styles.searchBox}>
              <SearchBar
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
              accessibilityRole="button"
              accessibilityLabel="Search this area"
            >
              <SearchAreaIcon color={loading ? '#7EB1FA' : '#0878F9'} />
              <Text style={styles.searchParkingText}>
                {loading ? 'Searching…' : 'Search this area'}
              </Text>
            </TouchableOpacity>
            {searchHint && (
              <View style={styles.searchHintBox}>
                <Text style={styles.searchHintText}>{searchHint}</Text>
              </View>
            )}
          </View>
        </>
      )}

      {!navActive && (
        <>
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
              onPress={handleBrowseRecenter}
              accessibilityRole="button"
              accessibilityLabel="Recenter map"
            >
              <AppIcon name="locate-outline" size={25} color="#0878F9" />
            </TouchableOpacity>
          </View>

          {/* Universal destination + routing bottom sheet */}
          <RouteBottomSheet
            destination={selectedDestination}
            parkingFeeStatus={
              selectedDestination?.type === 'parking' && selectedParking
                ? parkingFeeStatus(selectedParking.tags)
                : null
            }
            parkingAccessLabel={
              selectedDestination?.type === 'parking' && selectedParkingAccess
                ? parkingAccessLabel(selectedParkingAccess.source)
                : null
            }
            parkingAccessLoading={
              selectedDestination?.type === 'parking' && parkingAccessLoading
            }
            previewStatus={routePreview.kind}
            routeInfo={routePreview.kind === 'ready' ? routePreview.routeInfo : null}
            userLocation={userLocation}
            canNavigate={canNavigate}
            routeError={routePreview.kind === 'error' ? routePreview.message : null}
            locationDenied={locationDenied}
            onPreviewRoute={handlePreviewRoute}
            onStartRoute={handleStartRoute}
            onRequestLocation={ensureUserLocation}
            onClose={handleCloseSheet}
          />
        </>
      )}

      {/* Floating recenter button — only in free mode; restores following, car
          below centre, road ahead up. Sits above the bottom trip bar + safe area. */}
      {navActive && camera.cameraMode === 'free' && (
        <NavigationRecenterButton
          onPress={handleNavigationRecenter}
          bottom={insets.bottom + NAV_BOTTOM_BAR_HEIGHT + 24}
        />
      )}

      {/* Turn-by-turn navigation overlay (top banner + trip bar + status/errors) */}
      <NavigationPanel
        state={nav.state}
        onStop={nav.stop}
        onToggleMute={nav.toggleMute}
        onRecenter={handleNavigationRecenter}
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

const SearchAreaIcon = ({ color }: { color: string }) => (
  <View style={searchAreaIconStyles.container}>
    <View style={[searchAreaIconStyles.ring, { borderColor: color }]} />
    <View style={[searchAreaIconStyles.dot, { backgroundColor: color }]} />
    <View style={[searchAreaIconStyles.tickVertical, searchAreaIconStyles.tickTop, { backgroundColor: color }]} />
    <View style={[searchAreaIconStyles.tickVertical, searchAreaIconStyles.tickBottom, { backgroundColor: color }]} />
    <View style={[searchAreaIconStyles.tickHorizontal, searchAreaIconStyles.tickLeft, { backgroundColor: color }]} />
    <View style={[searchAreaIconStyles.tickHorizontal, searchAreaIconStyles.tickRight, { backgroundColor: color }]} />
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
    top: 64,
    left: 0,
    right: 0,
    alignItems: "center",
    zIndex: 80,
  },
  searchParkingBtn: {
    minHeight: 42,
    backgroundColor: "#FFFFFF",
    borderRadius: 22,
    paddingVertical: 9,
    paddingHorizontal: 18,
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "center",
    gap: 8,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: "rgba(15, 23, 42, 0.08)",
    shadowColor: "#0F172A",
    shadowOffset: { width: 0, height: 3 },
    shadowOpacity: 0.14,
    shadowRadius: 8,
    elevation: 5,
  },
  searchParkingBtnBusy: { opacity: 0.72 },
  searchParkingText: {
    color: "#0878F9",
    fontSize: 14,
    fontWeight: "600",
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

const searchAreaIconStyles = StyleSheet.create({
  container: {
    width: 20,
    height: 20,
    position: "relative",
  },
  ring: {
    position: "absolute",
    left: 5,
    top: 5,
    width: 10,
    height: 10,
    borderRadius: 5,
    borderWidth: 1.5,
  },
  dot: {
    position: "absolute",
    left: 8.5,
    top: 8.5,
    width: 3,
    height: 3,
    borderRadius: 1.5,
  },
  tickVertical: {
    position: "absolute",
    left: 9.25,
    width: 1.5,
    height: 5,
    borderRadius: 1,
  },
  tickTop: { top: 0 },
  tickBottom: { bottom: 0 },
  tickHorizontal: {
    position: "absolute",
    top: 9.25,
    width: 5,
    height: 1.5,
    borderRadius: 1,
  },
  tickLeft: { left: 0 },
  tickRight: { right: 0 },
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
