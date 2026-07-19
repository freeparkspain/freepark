import { LatLng } from '../../types/parking';
import { NavigationError, NavigationRoute, NavigationStep } from '../../types/navigation';
import { OsrmRouteResponse, OsrmStep } from './osrmTypes';
import { decodePolyline6 } from './polyline';
import { generateInstruction } from './instructionGenerator';
import { sanitizeRouteCoordinates } from '../../navigation/services/routeValidator';

// ─── OSRM JSON → domain NavigationRoute ───────────────────────────────────────
// The single boundary where the raw wire format is translated into the app's
// own models. Throws NavigationError (RU, user-facing) for every "no usable
// route" condition so the caller never has to inspect OSRM internals.

// A car can't cross open water — but OSRM's driving profile still routes over
// any `route=ferry` way OSM tags as vehicle-accessible, which can turn a
// "route" into "drive to a terminal, sail for days, drive again" instead of
// erroring out. Real car ferries used for everyday/holiday driving (English
// Channel, Baltic hops, Mediterranean islands, even Barcelona↔Italy) top out
// around a few hundred km; nothing this app needs to support requires more
// than that, so a single ferry LEG beyond this is treated as "not a real
// driving route" — a precise stand-in for "these two points are effectively
// on different continents" without capping ordinary long overland trips.
const MAX_FERRY_LEG_METERS = 1_500_000; // 1500 km

// Ferry detection alone isn't enough: two points on the SAME landmass can
// still be absurdly far apart by road (e.g. Málaga → Siberia is ~13,200 km
// of pure overland driving through Russia, no water crossing at all — OSRM
// happily returns it as a 190-hour route). Nothing this app needs — finding
// parking near where you already are — ever requires more than a long
// cross-country drive. Rejecting it here also stops MapScreen from ever
// calling fitToCoordinates on a route spanning most of the globe, which was
// forcing the camera to a near-whole-world zoom (the "map goes beyond its
// bounds" symptom). Same magnitude as MAX_FERRY_LEG_METERS for one easy rule:
// "further than 1500 km, however you'd get there, isn't a real trip here".
const MAX_ROUTE_DISTANCE_METERS = 1_500_000; // 1500 km

function stepToNavigationStep(step: OsrmStep): NavigationStep {
  const [lon, lat] = step.maneuver.location;
  const maneuverLocation: LatLng = { latitude: lat, longitude: lon };
  const streetName = step.name && step.name.trim().length > 0 ? step.name.trim() : null;

  return {
    instruction: generateInstruction({
      type:       step.maneuver.type,
      modifier:   step.maneuver.modifier ?? null,
      streetName,
      exit:       step.maneuver.exit ?? null,
    }),
    maneuverLocation,
    distanceMeters:   step.distance,
    durationSeconds:  step.duration,
    maneuverType:     step.maneuver.type,
    maneuverModifier: step.maneuver.modifier ?? null,
    streetName,
    exit:             step.maneuver.exit ?? null,
  };
}

function mapSingleOsrmRoute(
  route: NonNullable<OsrmRouteResponse['routes']>[number],
): NavigationRoute {
  if (
    !Number.isFinite(route.distance) || route.distance < 0 ||
    !Number.isFinite(route.duration) || route.duration < 0
  ) {
    throw new NavigationError('The route data is invalid', false);
  }
  if (!route.geometry || route.geometry.length === 0) {
    throw new NavigationError('The server returned an empty route', false);
  }
  if (route.distance > MAX_ROUTE_DISTANCE_METERS) {
    throw new NavigationError('Destination is too far away for in-app navigation', false);
  }

  // Decode, then validate/sanitize: drop NaN/Infinity/out-of-range points and
  // consecutive duplicates so nothing corrupt reaches the polylines or camera.
  const points = sanitizeRouteCoordinates(decodePolyline6(route.geometry));
  if (points.length < 2) {
    throw new NavigationError('The route data is invalid', false);
  }

  const steps: NavigationStep[] = [];
  let ferryDistanceMeters = 0;
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      if (step.mode === 'ferry') ferryDistanceMeters += step.distance;
      steps.push(stepToNavigationStep(step));
    }
  }

  if (steps.length === 0) {
    // Geometry without steps can still be drawn, but there is nothing to guide
    // with — treat as unusable for turn-by-turn.
    throw new NavigationError('No step-by-step directions for this route', false);
  }

  if (ferryDistanceMeters > MAX_FERRY_LEG_METERS) {
    throw new NavigationError('This route requires a long sea crossing and is not supported', false);
  }

  return {
    points,
    steps,
    totalDistanceMeters:  route.distance,
    totalDurationSeconds: route.duration,
  };
}

/** Select the shortest valid OSRM alternative; duration breaks equal distances. */
export function mapOsrmToRoute(resp: OsrmRouteResponse): NavigationRoute {
  if (resp.code === 'NoRoute') {
    throw new NavigationError('No route found', false);
  }
  if (resp.code !== 'Ok' || !resp.routes || resp.routes.length === 0) {
    throw new NavigationError('No route found', false);
  }

  const ranked = resp.routes
    .map((route, index) => ({ route, index }))
    .sort((first, second) => {
      const firstDistance = Number.isFinite(first.route.distance)
        ? first.route.distance
        : Number.POSITIVE_INFINITY;
      const secondDistance = Number.isFinite(second.route.distance)
        ? second.route.distance
        : Number.POSITIVE_INFINITY;
      const firstDuration = Number.isFinite(first.route.duration)
        ? first.route.duration
        : Number.POSITIVE_INFINITY;
      const secondDuration = Number.isFinite(second.route.duration)
        ? second.route.duration
        : Number.POSITIVE_INFINITY;
      return firstDistance - secondDistance ||
        firstDuration - secondDuration ||
        first.index - second.index;
    });

  let firstError: NavigationError | null = null;
  for (const candidate of ranked) {
    try {
      return mapSingleOsrmRoute(candidate.route);
    } catch (error) {
      if (error instanceof NavigationError && !firstError) firstError = error;
    }
  }
  throw firstError ?? new NavigationError('No route found', false);
}
