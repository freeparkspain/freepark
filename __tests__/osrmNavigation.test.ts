import { navigationRouteToPreviewResult } from '../services/navigation/osrmNavigation';
import type { NavigationRoute } from '../types/navigation';

describe('navigationRouteToPreviewResult', () => {
  it('preserves the exact route and converts metres/seconds to km/minutes', () => {
    const route: NavigationRoute = {
      points: [
        { latitude: 36.72, longitude: -4.42 },
        { latitude: 36.73, longitude: -4.41 },
      ],
      steps: [{
        instruction: 'Continue',
        maneuverLocation: { latitude: 36.72, longitude: -4.42 },
        distanceMeters: 1_500,
        durationSeconds: 600,
        maneuverType: 'continue',
        maneuverModifier: null,
        streetName: null,
        exit: null,
      }],
      totalDistanceMeters: 1_500,
      totalDurationSeconds: 600,
    };

    const result = navigationRouteToPreviewResult(route);
    expect(result.navigationRoute).toBe(route);
    expect(result.polyline).toBe(route.points);
    expect(result.routeInfo).toEqual({ distance: 1.5, duration: 10 });
  });
});
