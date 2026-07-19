import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import MapView from 'react-native-maps';
import { LatLng } from '../types/parking';
import {
  MapEdgePadding,
  MapViewportLayout,
  NavigationCameraMode,
} from '../types/navigation';
import { NAVIGATION_CAMERA_CONFIG, CAR_TRACKING_CONFIG } from '../constants/navigation';
import {
  computeMapPadding,
  defaultMapPadding,
  drivingZoom,
  resolveRecenterBearing,
  shouldEnterFreeMode,
  shouldFocusNavigationSession,
} from '../navigation/services/cameraLogic';
import { firstSegmentBearing } from '../navigation/services/routeMatcher';
import { isValidCoordinate } from '../navigation/services/routeValidator';

// ─── useNavigationCamera ──────────────────────────────────────────────────────
// Owns the navigation camera mode (SINGLE source of truth). In `following` it
// glides the camera to the car (heading = car bearing, navigation zoom/pitch,
// car ~70% down via mapPadding). Any genuine user gesture flips to `free`, where
// the camera stops chasing the car but everything else keeps running.
// Google Maps' native `isGesture` signal prevents animateCamera completions from
// being mistaken for user gestures.

export interface UseNavigationCameraParams {
  mapRef:                React.RefObject<MapView | null>;
  layout:                MapViewportLayout;
  carPosition:           LatLng | null;
  carBearing:            number;
  matchedSegmentBearing: number | null;
  routeCoordinates:      LatLng[];
  navigationActive:      boolean;
  /** Increments only when the user starts/restarts navigation to a destination. */
  navigationSessionRevision: number;
  gpsBearing:            number | null;
  speedMps:              number | null;
  distanceToNextManeuverMeters: number | null;
}

export interface UseNavigationCameraResult {
  cameraMode:                 NavigationCameraMode;
  mapPadding:                 MapEdgePadding;
  recenter:                   () => void;
  enterFreeMode:              () => void;
  showOverview:               (remainingCoordinates: LatLng[]) => void;
  handleRegionChangeComplete: (isGesture?: boolean) => void;
}

const config = NAVIGATION_CAMERA_CONFIG;

export function useNavigationCamera(params: UseNavigationCameraParams): UseNavigationCameraResult {
  const {
    mapRef, layout, carPosition, carBearing, matchedSegmentBearing,
    routeCoordinates, navigationActive, navigationSessionRevision, gpsBearing, speedMps,
    distanceToNextManeuverMeters,
  } = params;

  const [cameraMode, setCameraMode] = useState<NavigationCameraMode>('following');
  const focusedSessionRevisionRef = useRef<number | null>(null);
  const skipNextFollowAnimationRef = useRef(false);

  // Latest speed held in a ref so `animateTo` stays a STABLE callback — otherwise
  // it changed every GPS tick and re-fired the follow effect (re-animating the
  // camera to the same spot each tick, churning the map and occasionally
  // dropping the route). Now the camera only moves when the car actually moves.
  const speedRef = useRef(speedMps);
  speedRef.current = speedMps;
  const maneuverDistanceRef = useRef(distanceToNextManeuverMeters);
  maneuverDistanceRef.current = distanceToNextManeuverMeters;

  const animateTo = useCallback((center: LatLng, heading: number) => {
    mapRef.current?.animateCamera(
      {
        center,
        heading,
        pitch: config.pitch,
        zoom: drivingZoom(speedRef.current, config.zoom, maneuverDistanceRef.current),
      },
      { duration: config.animationDurationMs },
    );
  }, [mapRef]);

  const enterFreeMode = useCallback(() => setCameraMode('free'), []);

  // Overview: fit the whole remaining route without stopping navigation. Guards
  // against invalid/degenerate bounds (which crash native fit methods). Recenter
  // returns to following.
  const showOverview = useCallback((remainingCoordinates: LatLng[]) => {
    const valid = remainingCoordinates.filter(isValidCoordinate);
    if (valid.length < 2) return;
    setCameraMode('overview');
    mapRef.current?.fitToCoordinates(valid, {
      edgePadding: {
        top:    layout.safeAreaTop + layout.topOverlayHeight + 40,
        bottom: layout.safeAreaBottom + layout.bottomOverlayHeight + 40,
        left:   40,
        right:  40,
      },
      animated: true,
    });
  }, [mapRef, layout]);

  const recenter = useCallback(() => {
    const center = carPosition ?? routeCoordinates[0] ?? null;
    if (!center) return;
    // Bearing works immediately after route creation, before the car moves.
    const heading = resolveRecenterBearing({
      gpsBearing,
      speedMps,
      matchedSegmentBearing,
      firstSegmentBearing: firstSegmentBearing(routeCoordinates),
      mapBearing: null,
      minReliableSpeedMps: CAR_TRACKING_CONFIG.minReliableSpeedMps,
    });
    skipNextFollowAnimationRef.current = true;
    setCameraMode('following');
    animateTo(center, heading);
  }, [carPosition, routeCoordinates, gpsBearing, speedMps, matchedSegmentBearing, animateTo]);

  // Enter following when navigation begins or the user explicitly starts a new
  // destination. Automatic reroutes do not increment the session revision, so
  // they preserve an intentional free/overview camera mode.
  useEffect(() => {
    if (navigationActive) setCameraMode('following');
  }, [navigationActive, navigationSessionRevision]);

  // Guarantee one heading-up driving focus when a new navigation session has
  // both a route and a matched car position. Automatic reroutes keep the current
  // camera mode because they do not change navigationSessionRevision.
  useEffect(() => {
    if (!shouldFocusNavigationSession(
      navigationActive,
      routeCoordinates.length,
      Boolean(carPosition),
      navigationSessionRevision,
      focusedSessionRevisionRef.current,
    ) || !carPosition) return;
    const heading = resolveRecenterBearing({
      gpsBearing,
      speedMps,
      matchedSegmentBearing,
      firstSegmentBearing: firstSegmentBearing(routeCoordinates),
      mapBearing: null,
      minReliableSpeedMps: CAR_TRACKING_CONFIG.minReliableSpeedMps,
    });
    focusedSessionRevisionRef.current = navigationSessionRevision;
    skipNextFollowAnimationRef.current = true;
    setCameraMode('following');
    animateTo(carPosition, heading);
  }, [
    navigationActive,
    navigationSessionRevision,
    routeCoordinates,
    carPosition,
    gpsBearing,
    speedMps,
    matchedSegmentBearing,
    animateTo,
  ]);

  // Follow the car while in following mode. carPosition/carBearing are already
  // throttled by min-update thresholds, so this doesn't fire per frame.
  useEffect(() => {
    if (!navigationActive || cameraMode !== 'following' || !carPosition) return;
    if (skipNextFollowAnimationRef.current) {
      skipNextFollowAnimationRef.current = false;
      return;
    }
    animateTo(carPosition, carBearing);
  }, [navigationActive, cameraMode, carPosition, carBearing, animateTo]);

  // Called from the map's onRegionChangeComplete: flip to free only when the
  // Google Maps native event explicitly identifies a user gesture.
  const handleRegionChangeComplete = useCallback((isGesture?: boolean) => {
    if (!navigationActive) return;
    if (shouldEnterFreeMode(isGesture, cameraMode)) {
      setCameraMode('free');
    }
  }, [navigationActive, cameraMode]);

  useEffect(() => {
    if (!navigationActive) {
      focusedSessionRevisionRef.current = null;
      skipNextFollowAnimationRef.current = false;
    }
  }, [navigationActive]);

  // Keep a SINGLE padding for the whole navigation session (both following and
  // free) so panning — which flips following→free — doesn't change mapPadding.
  // A mapPadding change forces react-native-maps to re-layout its overlays,
  // which was making the route + parking markers momentarily vanish on pan.
  const mapPadding = useMemo(
    () => navigationActive
      ? computeMapPadding(layout, config.carVerticalPositionRatio)
      : defaultMapPadding(layout),
    [
      navigationActive,
      layout.width,
      layout.height,
      layout.topOverlayHeight,
      layout.bottomOverlayHeight,
      layout.safeAreaTop,
      layout.safeAreaBottom,
    ],
  );

  return { cameraMode, mapPadding, recenter, enterFreeMode, showOverview, handleRegionChangeComplete };
}
