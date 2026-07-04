import { LatLng, RouteInfo } from '../../types/parking';

export interface OsrmRouteResult {
  polyline: LatLng[];
  routeInfo: RouteInfo;
}

interface OsrmResponse {
  code: string;
  routes?: Array<{
    geometry: { type: string; coordinates: [number, number][] };
    distance: number;
    duration: number;
  }>;
}

export async function fetchOsrmRoute(
  origin: LatLng,
  destination: LatLng,
): Promise<OsrmRouteResult> {
  const url =
    `https://router.project-osrm.org/route/v1/driving/` +
    `${origin.longitude},${origin.latitude};${destination.longitude},${destination.latitude}` +
    `?overview=full&geometries=geojson&steps=true`;

  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`OSRM error ${response.status}`);
  }

  const data = (await response.json()) as OsrmResponse;

  if (data.code !== 'Ok' || !data.routes?.length) {
    throw new Error('No route found');
  }

  const route = data.routes[0];
  const polyline: LatLng[] = route.geometry.coordinates.map(([lon, lat]) => ({
    latitude: lat,
    longitude: lon,
  }));

  return {
    polyline,
    routeInfo: {
      distance: route.distance / 1000,  // meters → km
      duration: route.duration / 60,    // seconds → minutes
    },
  };
}
