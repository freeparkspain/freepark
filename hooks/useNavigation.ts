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
import { NavigationSessionGuard } from '../navigation/navigationSession';
import { RerouteController } from '../navigation/rerouteController';
import { VoiceGuidanceManager } from '../navigation/voiceGuidanceManager';
import { ExpoLocationProvider, LocationProvider } from '../navigation/locationProvider';
import { etaEpochMs } from '../navigation/format';
import { isFreshLocationSample, isValidLocationSample } from '../navigation/locationValidation';
import { isUsablePreparedNavigationRoute } from '../navigation/services/routeValidator';
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
  /** Increments for every explicit user start/restart. */
  sessionRevision: number;
  /** Increments whenever a new native route should be rendered. */
  routeRevision:   number;
  start:        (destination: LatLng) => Promise<void>;
  startPrepared: (destination: LatLng, route: NavigationRoute) => Promise<void>;
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
  const sessionGuardRef     = useRef(new NavigationSessionGuard());
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
  const [sessionRevision, setSessionRevision] = useState(0);
  const [routeRevision, setRouteRevision] = useState(0);

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
    sessionGuardRef.current.invalidate();
    // Invalidate even a repository that does not honour AbortSignal.
    routeRequestIdRef.current++;
    routeAbortRef.current?.abort();
    routeAbortRef.current = null;
    engineRef.current = null;
    rerouteRef.current = null;
    rerouteInFlightRef.current = false;
    isReroutingRef.current = false;
    voiceRef.current.dispose();
  }, []);

  const applyRoute = useCallback((newRoute: NavigationRoute) => {
    engineRef.current = new NavigationEngine(newRoute, config);
    travelledRef.current = 0;
    voiceRef.current.reset();
    setRoute(newRoute);
    setRouteRevision((revision) => revision + 1);
  }, [config]);

  const finishArrived = useCallback((sessionId: number) => {
    if (!sessionGuardRef.current.isCurrent(sessionId)) return;
    const dest = destinationRef.current;
    teardown();
    // Announce after teardown, whose dispose() intentionally stops any stale
    // maneuver prompt. Otherwise the arrival phrase is cancelled immediately.
    voiceRef.current.announceNow('You have arrived at your destination');
    if (dest) apply({ kind: 'arrived', destination: dest });
  }, [apply, teardown]);

  const triggerReroute = useCallback(async (sample: LocationSample, sessionId: number) => {
    if (
      !sessionGuardRef.current.isCurrent(sessionId) ||
      rerouteInFlightRef.current ||
      !destinationRef.current
    ) return;
    rerouteInFlightRef.current = true;
    isReroutingRef.current = true;
    rerouteRef.current?.markRerouted(sample.timestampMs);
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
      if (
        routeRequestIdRef.current !== reqId ||
        !activeRef.current ||
        !sessionGuardRef.current.isCurrent(sessionId)
      ) return;
      applyRoute(fresh);
      voiceRef.current.announceNow('Route recalculated');
    } catch (err) {
      // Aborted (superseded) or failed — keep guiding on the existing route.
      if (err instanceof Error && err.name === 'AbortError') return;
    } finally {
      if (sessionGuardRef.current.isCurrent(sessionId)) {
        if (routeAbortRef.current === ctrl) routeAbortRef.current = null;
        rerouteInFlightRef.current = false;
        isReroutingRef.current = false;
        if (stateRef.current.kind === 'navigating') {
          apply({ ...stateRef.current, isRerouting: false });
        }
      }
    }
  }, [apply, applyRoute]);

  const handleSample = useCallback((sample: LocationSample, sessionId: number) => {
    if (
      !sessionGuardRef.current.isCurrent(sessionId) ||
      !isValidLocationSample(sample)
    ) return;
    const engine = engineRef.current;
    if (!activeRef.current || !engine) return;

    setLocation(sample);

    const progress = engine.computeProgress(sample.position, travelledRef.current);
    travelledRef.current = progress.travelledMeters;

    if (progress.hasArrived) {
      finishArrived(sessionId);
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
      void triggerReroute(sample, sessionId);
    }
  }, [apply, buildNavigating, config.maxUsableAccuracyMeters, finishArrived, triggerReroute]);

  const onLocationError = useCallback((err: NavigationError, sessionId: number) => {
    if (!sessionGuardRef.current.isCurrent(sessionId)) return;
    // Expo's watcher error callback is used for setup/service failures, not for
    // ordinary accuracy fluctuations. Continuing would leave a route UI with no
    // live car updates, so terminate this session and offer Retry.
    teardown();
    apply({ kind: 'error', message: err.message, recoverable: err.recoverable });
  }, [apply, teardown]);

  const startInternal = useCallback(async (
    dest: LatLng,
    preparedRoute: NavigationRoute | null,
  ) => {
    teardown();
    const sessionId = sessionGuardRef.current.begin();
    setSessionRevision((revision) => revision + 1);
    activeRef.current = true;
    destinationRef.current = dest;
    setDestination(dest);
    setLocation(null);
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
    if (!sessionGuardRef.current.isCurrent(sessionId)) return;
    if (!granted) {
      activeRef.current = false;
      sessionGuardRef.current.complete(sessionId);
      apply({ kind: 'error', message: 'Location access denied. Enable it in Settings', recoverable: true });
      return;
    }

    const current = await providerRef.current.getCurrent();
    if (!sessionGuardRef.current.isCurrent(sessionId)) return;
    if (!current || !isFreshLocationSample(current, Date.now())) {
      activeRef.current = false;
      sessionGuardRef.current.complete(sessionId);
      apply({ kind: 'error', message: 'Could not determine your location. Check your GPS', recoverable: true });
      return;
    }
    setLocation(current);

    apply({ kind: 'buildingRoute' });
    const preparedIsUsable = isUsablePreparedNavigationRoute(preparedRoute);
    let initial: NavigationRoute;

    if (preparedIsUsable) {
      initial = preparedRoute!;
    } else {
      routeAbortRef.current?.abort();
      const ctrl = new AbortController();
      routeAbortRef.current = ctrl;
      const reqId = ++routeRequestIdRef.current;
      try {
        initial = await repositoryRef.current.getRoute(current.position, dest, ctrl.signal);
      } catch (err) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (
          routeRequestIdRef.current !== reqId ||
          !sessionGuardRef.current.isCurrent(sessionId)
        ) return;
        activeRef.current = false;
        sessionGuardRef.current.complete(sessionId);
        const message = err instanceof NavigationError ? err.message : 'Could not build the route';
        const recoverable = err instanceof NavigationError ? err.recoverable : true;
        apply({ kind: 'error', message, recoverable });
        return;
      }
      if (routeRequestIdRef.current !== reqId) return;
      if (routeAbortRef.current === ctrl) routeAbortRef.current = null;
    }

    if (!activeRef.current || !sessionGuardRef.current.isCurrent(sessionId)) return;

    applyRoute(initial);
    const progress = engineRef.current!.computeProgress(current.position, 0);
    travelledRef.current = progress.travelledMeters;
    apply(buildNavigating(progress));

    try {
      const stopWatch = await providerRef.current.watch(
        (sample) => handleSample(sample, sessionId),
        (error) => onLocationError(error, sessionId),
      );
      sessionGuardRef.current.adoptWatch(sessionId, stopWatch);
    } catch {
      onLocationError(
        new NavigationError('Could not start live location tracking', true),
        sessionId,
      );
    }
  }, [apply, applyRoute, buildNavigating, config, handleSample, onLocationError, teardown]);

  const start = useCallback(
    (dest: LatLng) => startInternal(dest, null),
    [startInternal],
  );

  const startPrepared = useCallback(
    (dest: LatLng, preparedRoute: NavigationRoute) => startInternal(dest, preparedRoute),
    [startInternal],
  );

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
    sessionRevision,
    routeRevision,
    start,
    startPrepared,
    stop,
    toggleMute,
    setFollowing,
    recenter,
  };
}
