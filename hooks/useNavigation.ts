import { useCallback, useEffect, useRef, useState } from 'react';
import { LatLng } from '../types/parking';
import {
  LocationSample,
  NavigationError,
  NavigationProgress,
  NavigationRoute,
  NavigationState,
} from '../types/navigation';
import { NAVIGATION_CONFIG } from '../constants/navigation';
import { NavigationEngine } from '../navigation/navigationEngine';
import { RerouteController } from '../navigation/rerouteController';
import { VoiceGuidanceManager } from '../navigation/voiceGuidanceManager';
import { ExpoLocationProvider, LocationProvider } from '../navigation/locationProvider';
import { etaEpochMs } from '../navigation/format';
import {
  createDefaultNavigationRepository,
  NavigationRepository,
} from '../services/navigation/navigationRepository';

// ─── useNavigation — the turn-by-turn "ViewModel" ─────────────────────────────
// Owns the navigation session lifecycle and glues the pure engine to live GPS,
// voice and the routing repository. All heavy logic lives in the injected,
// unit-tested collaborators; this hook only orchestrates them and exposes a
// small, explicit surface + a NavigationState to render. No business rules,
// no direct expo-location/expo-speech calls here.

export interface UseNavigation {
  state:       NavigationState;
  route:       NavigationRoute | null;
  location:    LocationSample | null;
  destination: LatLng | null;
  isActive:    boolean;
  start:        (destination: LatLng) => Promise<void>;
  stop:         () => void;
  toggleMute:   () => void;
  setFollowing: (following: boolean) => void;
  recenter:     () => void;
}

export function useNavigation(deps?: {
  repository?: NavigationRepository;
  locationProvider?: LocationProvider;
  voice?: VoiceGuidanceManager;
}): UseNavigation {
  const config = NAVIGATION_CONFIG;

  // Long-lived collaborators (created once).
  const repositoryRef = useRef<NavigationRepository>(
    deps?.repository ?? createDefaultNavigationRepository(),
  );
  const providerRef = useRef<LocationProvider>(
    deps?.locationProvider ?? new ExpoLocationProvider(),
  );
  const voiceRef = useRef<VoiceGuidanceManager>(deps?.voice ?? new VoiceGuidanceManager());

  // Per-session mutable state (refs so async callbacks always read fresh values).
  const engineRef           = useRef<NavigationEngine | null>(null);
  const rerouteRef          = useRef<RerouteController | null>(null);
  const destinationRef      = useRef<LatLng | null>(null);
  const travelledRef        = useRef(0);
  const watchStopRef        = useRef<() => void>(() => {});
  const routeAbortRef       = useRef<AbortController | null>(null);
  // Monotonic id shared by the initial fetch and every reroute: only the newest
  // request may commit a route, so a slow/stale response can't clobber a fresher
  // one even if its abort didn't fire in time (latest-request-wins).
  const routeRequestIdRef   = useRef(0);
  const rerouteInFlightRef  = useRef(false);
  const isFollowingRef      = useRef(true);
  const isMutedRef          = useRef(false);
  const isReroutingRef      = useRef(false);
  const activeRef           = useRef(false);

  const [state, setStateRaw]     = useState<NavigationState>({ kind: 'idle' });
  const stateRef                 = useRef<NavigationState>({ kind: 'idle' });
  const [route, setRoute]        = useState<NavigationRoute | null>(null);
  const [location, setLocation]  = useState<LocationSample | null>(null);
  const [destination, setDestination] = useState<LatLng | null>(null);

  const apply = useCallback((s: NavigationState) => {
    stateRef.current = s;
    setStateRaw(s);
  }, []);

  const buildNavigating = useCallback((progress: NavigationProgress): NavigationState => {
    const upcoming = progress.upcomingStep;
    return {
      kind: 'navigating',
      currentInstruction:           upcoming?.instruction ?? 'Follow the route',
      streetName:                   upcoming?.streetName ?? null,
      distanceToNextManeuverMeters: progress.distanceToNextManeuverMeters,
      remainingDistanceMeters:      progress.remainingDistanceMeters,
      remainingDurationSeconds:     progress.remainingDurationSeconds,
      etaEpochMs:                   etaEpochMs(progress.remainingDurationSeconds),
      maneuverType:                 upcoming?.maneuverType ?? 'continue',
      maneuverModifier:             upcoming?.maneuverModifier ?? null,
      isMuted:                      isMutedRef.current,
      isFollowingUser:              isFollowingRef.current,
      isRerouting:                  isReroutingRef.current,
    };
  }, []);

  const teardown = useCallback(() => {
    activeRef.current = false;
    watchStopRef.current();
    watchStopRef.current = () => {};
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    rerouteInFlightRef.current = false;
    isReroutingRef.current = false;
    voiceRef.current.dispose();
  }, []);

  const applyRoute = useCallback((newRoute: NavigationRoute) => {
    engineRef.current = new NavigationEngine(newRoute, config);
    travelledRef.current = 0;
    rerouteRef.current?.reset();
    voiceRef.current.reset();
    setRoute(newRoute);
  }, [config]);

  const finishArrived = useCallback(() => {
    const dest = destinationRef.current;
    voiceRef.current.announceNow('You have arrived at your destination');
    teardown();
    if (dest) apply({ kind: 'arrived', destination: dest });
  }, [apply, teardown]);

  const triggerReroute = useCallback(async (sample: LocationSample) => {
    if (rerouteInFlightRef.current || !destinationRef.current) return;
    rerouteInFlightRef.current = true;
    isReroutingRef.current = true;
    rerouteRef.current?.markRerouted(sample.timestampMs);
    voiceRef.current.announceNow('Route recalculated');
    if (stateRef.current.kind === 'navigating') {
      apply({ ...stateRef.current, isRerouting: true });
    }

    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    const reqId = ++routeRequestIdRef.current;

    try {
      const fresh = await repositoryRef.current.getRoute(
        sample.position,
        destinationRef.current,
        ctrl.signal,
      );
      if (routeRequestIdRef.current !== reqId || !activeRef.current) return;
      applyRoute(fresh);
    } catch (err) {
      // Aborted (superseded) or failed — keep guiding on the existing route.
      if (err instanceof Error && err.name === 'AbortError') return;
    } finally {
      rerouteInFlightRef.current = false;
      isReroutingRef.current = false;
      if (stateRef.current.kind === 'navigating') {
        apply({ ...stateRef.current, isRerouting: false });
      }
    }
  }, [apply, applyRoute]);

  const handleSample = useCallback((sample: LocationSample) => {
    const engine = engineRef.current;
    if (!activeRef.current || !engine) return;

    setLocation(sample);

    const progress = engine.computeProgress(sample.position, travelledRef.current);
    travelledRef.current = progress.travelledMeters;

    if (progress.hasArrived) {
      finishArrived();
      return;
    }

    // Voice: announce the upcoming maneuver (skip while a reroute is resolving).
    if (progress.upcomingStep && !isReroutingRef.current) {
      voiceRef.current.maybeAnnounce(
        progress.currentStepIndex + 1,           // stable key for the upcoming maneuver
        progress.upcomingStep.instruction,
        progress.distanceToNextManeuverMeters,
        sample.speedMps,
      );
    }

    apply(buildNavigating(progress));

    // Reroute only on confirmed off-route with usable GPS accuracy.
    const accuracyOk =
      sample.accuracyMeters == null || sample.accuracyMeters <= config.maxUsableAccuracyMeters;
    const offRoute = progress.isOffRoute && accuracyOk;
    if (rerouteRef.current?.update(offRoute, sample.timestampMs)) {
      void triggerReroute(sample);
    }
  }, [apply, buildNavigating, config.maxUsableAccuracyMeters, finishArrived, triggerReroute]);

  const onLocationError = useCallback((err: NavigationError) => {
    // Only surface as a hard error before we're navigating; transient signal
    // loss mid-route shouldn't tear down the active guidance UI.
    if (stateRef.current.kind !== 'navigating') {
      apply({ kind: 'error', message: err.message, recoverable: err.recoverable });
    }
  }, [apply]);

  const start = useCallback(async (dest: LatLng) => {
    teardown();
    activeRef.current = true;
    destinationRef.current = dest;
    setDestination(dest);
    travelledRef.current = 0;
    isMutedRef.current = false;
    isFollowingRef.current = true;
    isReroutingRef.current = false;
    voiceRef.current.setMuted(false);
    voiceRef.current.reset();
    rerouteRef.current = new RerouteController(config);
    setRoute(null);

    apply({ kind: 'requestingLocation' });
    const granted = await providerRef.current.ensurePermission();
    if (!granted) {
      activeRef.current = false;
      apply({ kind: 'error', message: 'Location access denied. Enable it in Settings', recoverable: true });
      return;
    }

    const current = await providerRef.current.getCurrent();
    if (!current) {
      activeRef.current = false;
      apply({ kind: 'error', message: 'Could not determine your location. Check your GPS', recoverable: true });
      return;
    }
    setLocation(current);

    apply({ kind: 'buildingRoute' });
    routeAbortRef.current?.abort();
    const ctrl = new AbortController();
    routeAbortRef.current = ctrl;
    const reqId = ++routeRequestIdRef.current;

    let initial: NavigationRoute;
    try {
      initial = await repositoryRef.current.getRoute(current.position, dest, ctrl.signal);
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') return;
      if (routeRequestIdRef.current !== reqId) return; // superseded — ignore
      activeRef.current = false;
      const message = err instanceof NavigationError ? err.message : 'Could not build the route';
      const recoverable = err instanceof NavigationError ? err.recoverable : true;
      apply({ kind: 'error', message, recoverable });
      return;
    }
    if (routeRequestIdRef.current !== reqId || !activeRef.current) return;

    applyRoute(initial);
    const progress = engineRef.current!.computeProgress(current.position, 0);
    travelledRef.current = progress.travelledMeters;
    apply(buildNavigating(progress));

    watchStopRef.current = await providerRef.current.watch(handleSample, onLocationError);
  }, [apply, applyRoute, buildNavigating, config, handleSample, onLocationError, teardown]);

  const stop = useCallback(() => {
    teardown();
    setRoute(null);
    setLocation(null);
    setDestination(null);
    destinationRef.current = null;
    apply({ kind: 'idle' });
  }, [apply, teardown]);

  const toggleMute = useCallback(() => {
    isMutedRef.current = !isMutedRef.current;
    voiceRef.current.setMuted(isMutedRef.current);
    if (stateRef.current.kind === 'navigating') {
      apply({ ...stateRef.current, isMuted: isMutedRef.current });
    }
  }, [apply]);

  const setFollowing = useCallback((following: boolean) => {
    if (isFollowingRef.current === following) return;
    isFollowingRef.current = following;
    if (stateRef.current.kind === 'navigating') {
      apply({ ...stateRef.current, isFollowingUser: following });
    }
  }, [apply]);

  const recenter = useCallback(() => setFollowing(true), [setFollowing]);

  // Clean up GPS/TTS/coroutines on unmount — no leaks.
  useEffect(() => () => teardown(), [teardown]);

  return {
    state,
    route,
    location,
    destination,
    isActive: state.kind !== 'idle',
    start,
    stop,
    toggleMute,
    setFollowing,
    recenter,
  };
}
