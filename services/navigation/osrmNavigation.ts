import { LatLng, RouteInfo } from '../../types/parking';
import { createDefaultNavigationRepository } from './navigationRepository';

export interface OsrmRouteResult {
  polyline: LatLng[];
  routeInfo: RouteInfo;
}

// Backwards-compatible helper used by the lightweight route preview. Now backed
// by the shared NavigationRepository so there is a single OSRM code path (URL
// building, polyline decoding, error handling) instead of two. RouteInfo keeps
// its historical units: distance in km, duration in minutes.
const repository = createDefaultNavigationRepository();

export async function fetchOsrmRoute(
  origin: LatLng,
  destination: LatLng,
): Promise<OsrmRouteResult> {
  const route = await repository.getRoute(origin, destination);
  return {
    polyline: route.points,
    routeInfo: {
      distance: route.totalDistanceMeters / 1000, // metres → km
      duration: route.totalDurationSeconds / 60,   // seconds → minutes
    },
  };
}
