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

  it('selects the shortest valid alternative instead of blindly taking the first', () => {
    const resp = okResponse();
    const first = resp.routes![0];
    resp.routes = [
      { ...first, distance: 900, duration: 70 },
      { ...first, distance: 650, duration: 80 },
      { ...first, distance: 700, duration: 60 },
    ];

    const route = mapOsrmToRoute(resp);
    expect(route.totalDistanceMeters).toBe(650);
    expect(route.totalDurationSeconds).toBe(80);
  });

  it('uses duration as the tie-breaker for equal-distance alternatives', () => {
    const resp = okResponse();
    const first = resp.routes![0];
    resp.routes = [
      { ...first, distance: 650, duration: 85 },
      { ...first, distance: 650, duration: 70 },
    ];

    expect(mapOsrmToRoute(resp).totalDurationSeconds).toBe(70);
  });

  it('skips a shorter malformed alternative and uses the next valid route', () => {
    const resp = okResponse();
    const valid = resp.routes![0];
    resp.routes = [
      { ...valid, geometry: '', distance: 400 },
      { ...valid, distance: 500 },
    ];

    expect(mapOsrmToRoute(resp).totalDistanceMeters).toBe(500);
  });

  it('accepts a route with a short car-ferry leg (a real strait/island crossing)', () => {
    const resp = okResponse();
    resp.routes![0].legs[0].steps![0].mode = 'ferry';
    resp.routes![0].legs[0].steps![0].distance = 50_000; // 50 km — a normal ferry hop

    expect(() => mapOsrmToRoute(resp)).not.toThrow();
  });

  it('rejects a route whose ferry leg is long enough to only make sense between continents', () => {
    const resp = okResponse();
    resp.routes![0].legs[0].steps![0].mode = 'ferry';
    resp.routes![0].legs[0].steps![0].distance = 6_000_000; // 6000 km — transatlantic-scale

    expect(() => mapOsrmToRoute(resp)).toThrow('This route requires a long sea crossing and is not supported');
  });

  it('sums ferry distance across multiple ferry steps, not just the first', () => {
    const resp = okResponse();
    resp.routes![0].legs[0].steps![0].mode = 'ferry';
    resp.routes![0].legs[0].steps![0].distance = 800_000;
    resp.routes![0].legs[0].steps![1].mode = 'ferry';
    resp.routes![0].legs[0].steps![1].distance = 800_000;
    // 1.6M m combined exceeds the threshold even though neither leg alone does.

    expect(() => mapOsrmToRoute(resp)).toThrow('This route requires a long sea crossing and is not supported');
  });

  it('falls back to a valid alternative when the shortest route needs an impossible ferry crossing', () => {
    const resp = okResponse();
    const valid = resp.routes![0];
    const impossibleFerry = {
      ...valid,
      distance: 400,
      legs: [{
        ...valid.legs[0],
        steps: valid.legs[0].steps!.map((s, i) => i === 0 ? { ...s, mode: 'ferry', distance: 6_000_000 } : s),
      }],
    };
    resp.routes = [impossibleFerry, { ...valid, distance: 500 }];

    expect(mapOsrmToRoute(resp).totalDistanceMeters).toBe(500);
  });

  it('accepts a long but plausible overland trip (well under the cap)', () => {
    const resp = okResponse();
    resp.routes![0].distance = 900_000; // 900 km — a long but real drive

    expect(() => mapOsrmToRoute(resp)).not.toThrow();
  });

  it('rejects a route that is absurdly far by road even with zero ferry distance (e.g. Málaga to Siberia)', () => {
    const resp = okResponse();
    resp.routes![0].distance = 13_219_900; // 13,220 km, pure overland — no ferry step at all

    expect(() => mapOsrmToRoute(resp)).toThrow('Destination is too far away for in-app navigation');
  });
});
