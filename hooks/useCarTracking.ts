import { useEffect, useMemo, useRef, useState } from 'react';
import { Animated } from 'react-native';
import { AnimatedRegion } from 'react-native-maps';
import { LatLng } from '../types/parking';
import { LocationSample, MatchedLocation } from '../types/navigation';
import { haversineDistance } from '../utils/geo';
import {
  CAR_ANIMATION_CONFIG,
  CAR_TRACKING_CONFIG,
  NAVIGATION_CAMERA_CONFIG,
} from '../constants/navigation';
import {
  buildRouteIndex,
  matchToRoute,
  PrevMatch,
  RouteIndex,
} from '../navigation/services/routeMatcher';
import { normalizeBearing, resolveTravelBearing, shortestBearingDelta } from '../navigation/services/bearing';
import { computeAnimationDurationMs, isLargeJump } from '../navigation/services/carAnimation';
import { isValidCoordinate } from '../navigation/services/routeValidator';

// ─── useCarTracking ───────────────────────────────────────────────────────────
// Turns raw GPS samples into a smoothly moving, route-snapped, correctly-rotated
// car. Position animates via an AnimatedRegion (no per-frame React state);
// rotation animates a single Animated.Value bound to the marker's native
// `rotation`. Matched location / car position / bearing are exposed as ~1 Hz
// state for the camera and UI. All animation internals live in refs.

export interface UseCarTrackingResult {
  animatedCoordinate: AnimatedRegion;
  rotation:           Animated.Value;
  matchedLocation:    MatchedLocation | null;
  carPosition:        LatLng | null;
  carBearing:         number;
}

export function useCarTracking(
  rawLocation: LocationSample | null,
  routeCoordinates: LatLng[],
  navigationActive: boolean,
): UseCarTrackingResult {
  const routeIndex: RouteIndex | null = useMemo(
    () => (routeCoordinates.length >= 2 ? buildRouteIndex(routeCoordinates) : null),
    [routeCoordinates],
  );

  const animatedCoordinate = useRef(
    new AnimatedRegion({ latitude: 0, longitude: 0, latitudeDelta: 0, longitudeDelta: 0 }),
  ).current;
  const rotation = useRef(new Animated.Value(0)).current;

  const prevMatchRef       = useRef<PrevMatch | null>(null);
  const prevMatchedPosRef  = useRef<LatLng | null>(null);
  const displayedPosRef    = useRef<LatLng | null>(null);
  const displayedBearingRef = useRef(0);
  const lastTsRef          = useRef<number | null>(null);
  const initializedRef     = useRef(false);
  const moveAnimRef        = useRef<Animated.CompositeAnimation | null>(null);
  const routeIndexOwnerRef = useRef<RouteIndex | null>(null);

  const [matchedLocation, setMatchedLocation] = useState<MatchedLocation | null>(null);
  const [carPosition, setCarPosition]         = useState<LatLng | null>(null);
  const [carBearing, setCarBearing]           = useState(0);

  // ── Per-sample update ──────────────────────────────────────────────────────
  useEffect(() => {
    if (routeIndexOwnerRef.current !== routeIndex) {
      // Route effects run after render in declaration order. Reset here,
      // synchronously before matching the first sample of a new route, so a
      // segment index from a longer previous route can never address past the
      // end of the new one.
      moveAnimRef.current?.stop();
      prevMatchRef.current = null;
      prevMatchedPosRef.current = null;
      routeIndexOwnerRef.current = routeIndex;
    }
    if (!navigationActive || !rawLocation || !routeIndex) return;

    const raw = rawLocation.position;
    // Ignore invalid GPS (NaN/Infinity/out-of-range) — never move the arrow to a
    // bad coordinate. The last valid displayed position is kept, so a corrupt or
    // momentarily-lost fix can't make the arrow disappear or jump off the map.
    if (!isValidCoordinate(raw)) return;

    const ts  = rawLocation.timestampMs;

    const match  = matchToRoute(routeIndex, raw, prevMatchRef.current, CAR_TRACKING_CONFIG);
    const target = match.matchedPosition;

    // ── Bearing (priority: segment → GPS → between-matched → last stable) ──────
    const bearing = resolveTravelBearing({
      snapped:             match.isSnappedToRoute,
      segmentBearing:      match.bearing,
      gpsBearing:          rawLocation.bearingDegrees,
      speedMps:            rawLocation.speedMps,
      prevMatched:         prevMatchedPosRef.current,
      currentMatched:      target,
      lastStable:          displayedBearingRef.current,
      minReliableSpeedMps: CAR_TRACKING_CONFIG.minReliableSpeedMps,
    });

    // ── Smooth movement (retarget latest; teleport on large gaps) ─────────────
    const from = displayedPosRef.current;
    const dist = from ? haversineDistance(from, target) : Infinity;
    const dt   = lastTsRef.current != null ? ts - lastTsRef.current : 0;

    if (!initializedRef.current || isLargeJump(dist, CAR_ANIMATION_CONFIG)) {
      moveAnimRef.current?.stop();
      animatedCoordinate.setValue({
        latitude: target.latitude, longitude: target.longitude,
        latitudeDelta: 0, longitudeDelta: 0,
      });
      initializedRef.current = true;
    } else {
      moveAnimRef.current?.stop(); // cancel the previous, retarget to the newest
      const duration = computeAnimationDurationMs(dist, dt, CAR_ANIMATION_CONFIG);
      // AnimatedRegion.timing animates the region fields (lat/lng); its RN Maps
      // type spuriously requires `toValue` — cast to bypass that library gap.
      const anim = animatedCoordinate.timing({
        latitude: target.latitude,
        longitude: target.longitude,
        latitudeDelta: 0,
        longitudeDelta: 0,
        duration,
        useNativeDriver: false,
      } as unknown as Parameters<AnimatedRegion['timing']>[0]);
      moveAnimRef.current = anim;
      anim.start();
    }

    // ── Smooth rotation along the shortest angular path ───────────────────────
    const cur = displayedBearingRef.current;
    const delta = shortestBearingDelta(cur, bearing);
    if (Math.abs(delta) >= NAVIGATION_CAMERA_CONFIG.minimumBearingUpdateDegrees) {
      const nextUnwrapped = cur + delta; // pass through 360 seamlessly
      Animated.timing(rotation, {
        toValue: nextUnwrapped,
        duration: 300,
        useNativeDriver: false,
      }).start(({ finished }) => {
        // Re-wrap to [0,360) once settled so the value can't grow unbounded.
        if (finished) rotation.setValue(normalizeBearing(nextUnwrapped));
      });
      displayedBearingRef.current = normalizeBearing(nextUnwrapped);
      setCarBearing(displayedBearingRef.current);
    }

    // ── Commit refs + throttled state ─────────────────────────────────────────
    prevMatchRef.current      = { progressMeters: match.routeProgressMeters, segmentIndex: match.routeSegmentIndex };
    prevMatchedPosRef.current = target;
    displayedPosRef.current   = target;
    lastTsRef.current         = ts;

    setMatchedLocation(match);
    setCarPosition((prev) =>
      !prev || haversineDistance(prev, target) >= NAVIGATION_CAMERA_CONFIG.minimumPositionUpdateMeters
        ? target
        : prev,
    );
  }, [rawLocation, navigationActive, routeIndex, animatedCoordinate, rotation]);

  // ── Reset when navigation stops ────────────────────────────────────────────
  useEffect(() => {
    if (navigationActive) return;
    moveAnimRef.current?.stop();
    rotation.stopAnimation();
    prevMatchRef.current = null;
    prevMatchedPosRef.current = null;
    displayedPosRef.current = null;
    displayedBearingRef.current = 0;
    lastTsRef.current = null;
    initializedRef.current = false;
    routeIndexOwnerRef.current = null;
    setMatchedLocation(null);
    setCarPosition(null);
    setCarBearing(0);
  }, [navigationActive, rotation]);

  // ── Cleanup on unmount (no leaks / no post-unmount updates) ────────────────
  useEffect(() => () => {
    moveAnimRef.current?.stop();
    rotation.stopAnimation();
  }, [rotation]);

  const currentMatchedLocation = routeIndexOwnerRef.current === routeIndex
    ? matchedLocation
    : null;

  return {
    animatedCoordinate,
    rotation,
    matchedLocation: currentMatchedLocation,
    carPosition,
    carBearing,
  };
}
