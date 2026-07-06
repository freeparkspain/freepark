import { useCallback, useEffect, useRef, useState } from 'react';
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
} from '../navigation/services/cameraLogic';
import { firstSegmentBearing } from '../navigation/services/routeMatcher';
import { isValidCoordinate } from '../navigation/services/routeValidator';

// ─── useNavigationCamera ──────────────────────────────────────────────────────
// Owns the navigation camera mode (SINGLE source of truth). In `following` it
// glides the camera to the car (heading = car bearing, navigation zoom/pitch,
// car ~70% down via mapPadding). Any genuine user gesture flips to `free`, where
// the camera stops chasing the car but everything else keeps running. A
// programmatic-move guard prevents our own animateCamera calls from being
// mistaken for user gestures.

export interface UseNavigationCameraParams {
  mapRef:                React.RefObject<MapView | null>;
  layout:                MapViewportLayout;
  carPosition:           LatLng | null;
  carBearing:            number;
  matchedSegmentBearing: number | null;
  routeCoordinates:      LatLng[];
  navigationActive:      boolean;
  gpsBearing:            number | null;
  speedMps:              number | null;
}

export interface UseNavigationCameraResult {
  cameraMode:                 NavigationCameraMode;
  mapPadding:                 MapEdgePadding;
  recenter:                   () => void;
  enterFreeMode:              () => void;
  showOverview:               (remainingCoordinates: LatLng[]) => void;
  handleRegionChangeComplete: () => void;
}

const config = NAVIGATION_CAMERA_CONFIG;

export function useNavigationCamera(params: UseNavigationCameraParams): UseNavigationCameraResult {
  const {
    mapRef, layout, carPosition, carBearing, matchedSegmentBearing,
    routeCoordinates, navigationActive, gpsBearing, speedMps,
  } = params;

  const [cameraMode, setCameraMode] = useState<NavigationCameraMode>('following');
  const isProgrammaticRef = useRef(false);
  const programmaticTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Latest speed held in a ref so `animateTo` stays a STABLE callback — otherwise
  // it changed every GPS tick and re-fired the follow effect (re-animating the
  // camera to the same spot each tick, churning the map and occasionally
  // dropping the route). Now the camera only moves when the car actually moves.
  const speedRef = useRef(speedMps);
  speedRef.current = speedMps;

  const markProgrammatic = useCallback((durationMs: number) => {
    isProgrammaticRef.current = true;
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
    programmaticTimer.current = setTimeout(() => {
      isProgrammaticRef.current = false;
    }, durationMs + 150); // small buffer past the animation
  }, []);

  const animateTo = useCallback((center: LatLng, heading: number) => {
    markProgrammatic(config.animationDurationMs);
    mapRef.current?.animateCamera(
      { center, heading, pitch: config.pitch, zoom: drivingZoom(speedRef.current, config.zoom) },
      { duration: config.animationDurationMs },
    );
  }, [mapRef, markProgrammatic]);

  const enterFreeMode = useCallback(() => setCameraMode('free'), []);

  // Overview: fit the whole remaining route without stopping navigation. Guards
  // against invalid/degenerate bounds (which crash native fit methods). Recenter
  // returns to following.
  const showOverview = useCallback((remainingCoordinates: LatLng[]) => {
    const valid = remainingCoordinates.filter(isValidCoordinate);
    if (valid.length < 2) return;
    setCameraMode('overview');
    markProgrammatic(config.animationDurationMs);
    mapRef.current?.fitToCoordinates(valid, {
      edgePadding: {
        top:    layout.safeAreaTop + layout.topOverlayHeight + 40,
        bottom: layout.safeAreaBottom + layout.bottomOverlayHeight + 40,
        left:   40,
        right:  40,
      },
      animated: true,
    });
  }, [mapRef, layout, markProgrammatic]);

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
    setCameraMode('following');
    animateTo(center, heading);
  }, [carPosition, routeCoordinates, gpsBearing, speedMps, matchedSegmentBearing, animateTo]);

  // Enter following automatically when a navigation session begins.
  useEffect(() => {
    if (navigationActive) setCameraMode('following');
  }, [navigationActive]);

  // Follow the car while in following mode. carPosition/carBearing are already
  // throttled by min-update thresholds, so this doesn't fire per frame.
  useEffect(() => {
    if (!navigationActive || cameraMode !== 'following' || !carPosition) return;
    animateTo(carPosition, carBearing);
  }, [navigationActive, cameraMode, carPosition, carBearing, animateTo]);

  // Called from the map's onRegionChangeComplete: flip to free only for genuine
  // user gestures (not our own programmatic camera animations).
  const handleRegionChangeComplete = useCallback(() => {
    if (!navigationActive) return;
    if (shouldEnterFreeMode(isProgrammaticRef.current, cameraMode)) {
      setCameraMode('free');
    }
  }, [navigationActive, cameraMode]);

  useEffect(() => () => {
    if (programmaticTimer.current) clearTimeout(programmaticTimer.current);
  }, []);

  // Keep a SINGLE padding for the whole navigation session (both following and
  // free) so panning — which flips following→free — doesn't change mapPadding.
  // A mapPadding change forces react-native-maps to re-layout its overlays,
  // which was making the route + parking markers momentarily vanish on pan.
  const mapPadding = navigationActive
    ? computeMapPadding(layout, config.carVerticalPositionRatio)
    : defaultMapPadding(layout);

  return { cameraMode, mapPadding, recenter, enterFreeMode, showOverview, handleRegionChangeComplete };
}
