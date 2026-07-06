import { mapOsrmToRoute } from '../services/navigation/osrmMapper';
import { OsrmRouteResponse } from '../services/navigation/osrmTypes';
import { encodePolyline } from '../services/navigation/polyline';
import { NavigationError } from '../types/navigation';

const geometry = encodePolyline(
  [
    { latitude: 40.0, longitude: 0.0 },
    { latitude: 40.0, longitude: 0.006 },
  ],
  6,
);

function okResponse(): OsrmRouteResponse {
  return {
    code: 'Ok',
    routes: [
      {
        geometry,
        distance: 500,
        duration: 60,
        legs: [
          {
            distance: 500,
            duration: 60,
            steps: [
              { maneuver: { type: 'depart', location: [0.0, 40.0] }, distance: 500, duration: 60, name: 'Calle A' },
              { maneuver: { type: 'turn', modifier: 'left', location: [0.006, 40.0] }, distance: 0, duration: 0, name: 'Calle B' },
              { maneuver: { type: 'arrive', location: [0.006, 40.0] }, distance: 0, duration: 0, name: '' },
            ],
          },
        ],
      },
    ],
  };
}

describe('mapOsrmToRoute', () => {
  it('maps a valid response to a domain route with English instructions', () => {
    const route = mapOsrmToRoute(okResponse());
    expect(route.points.length).toBeGreaterThanOrEqual(2);
    expect(route.totalDistanceMeters).toBe(500);
    expect(route.steps).toHaveLength(3);
    expect(route.steps[1].instruction).toBe('Turn left onto Calle B');
    expect(route.steps[1].streetName).toBe('Calle B');
    // Empty OSRM street name becomes null, not "".
    expect(route.steps[2].streetName).toBeNull();
  });

  it('throws NavigationError when no route is found', () => {
    expect(() => mapOsrmToRoute({ code: 'NoRoute' })).toThrow(NavigationError);
    expect(() => mapOsrmToRoute({ code: 'NoRoute' })).toThrow('No route found');
  });

  it('throws on empty geometry', () => {
    const resp = okResponse();
    resp.routes![0].geometry = '';
    expect(() => mapOsrmToRoute(resp)).toThrow(NavigationError);
  });

  it('throws when there are no steps', () => {
    const resp = okResponse();
    resp.routes![0].legs[0].steps = [];
    expect(() => mapOsrmToRoute(resp)).toThrow('No step-by-step directions for this route');
  });
});
