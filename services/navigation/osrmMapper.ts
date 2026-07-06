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

export function mapOsrmToRoute(resp: OsrmRouteResponse): NavigationRoute {
  if (resp.code === 'NoRoute') {
    throw new NavigationError('No route found', false);
  }
  if (resp.code !== 'Ok' || !resp.routes || resp.routes.length === 0) {
    throw new NavigationError('No route found', false);
  }

  const route = resp.routes[0];

  if (!route.geometry || route.geometry.length === 0) {
    throw new NavigationError('The server returned an empty route', false);
  }

  // Decode, then validate/sanitize: drop NaN/Infinity/out-of-range points and
  // consecutive duplicates so nothing corrupt reaches the polylines or camera.
  const points = sanitizeRouteCoordinates(decodePolyline6(route.geometry));
  if (points.length < 2) {
    throw new NavigationError('The route data is invalid', false);
  }

  const steps: NavigationStep[] = [];
  for (const leg of route.legs ?? []) {
    for (const step of leg.steps ?? []) {
      steps.push(stepToNavigationStep(step));
    }
  }

  if (steps.length === 0) {
    // Geometry without steps can still be drawn, but there is nothing to guide
    // with — treat as unusable for turn-by-turn.
    throw new NavigationError('No step-by-step directions for this route', false);
  }

  return {
    points,
    steps,
    totalDistanceMeters:  route.distance,
    totalDurationSeconds: route.duration,
  };
}
