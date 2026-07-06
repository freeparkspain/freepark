import { NavigationEngine } from '../navigation/navigationEngine';
import { NavigationConfig, NavigationRoute } from '../types/navigation';
import { LatLng } from '../types/parking';
import { haversineDistance } from '../utils/geo';

const config: NavigationConfig = {
  offRouteThresholdMeters: 50,
  offRouteConfirmationsRequired: 3,
  rerouteCooldownMillis: 10_000,
  destinationArrivalRadiusMeters: 25,
  maxUsableAccuracyMeters: 40,
};

// A straight west→east route at latitude 40, with a "turn" maneuver at p2.
const p0: LatLng = { latitude: 40, longitude: 0.000 };
const p1: LatLng = { latitude: 40, longitude: 0.003 };
const p2: LatLng = { latitude: 40, longitude: 0.006 };
const p3: LatLng = { latitude: 40, longitude: 0.009 };

const d01 = haversineDistance(p0, p1);
const d12 = haversineDistance(p1, p2);
const d23 = haversineDistance(p2, p3);
const total = d01 + d12 + d23;

const route: NavigationRoute = {
  points: [p0, p1, p2, p3],
  totalDistanceMeters: total,
  totalDurationSeconds: total / 10, // ~10 m/s
  steps: [
    { instruction: 'Head out', maneuverLocation: p0, distanceMeters: d01 + d12, durationSeconds: 0, maneuverType: 'depart', maneuverModifier: null, streetName: 'A', exit: null },
    { instruction: 'Turn left', maneuverLocation: p2, distanceMeters: d23, durationSeconds: 0, maneuverType: 'turn', maneuverModifier: 'left', streetName: 'B', exit: null },
    { instruction: 'You have arrived at your destination', maneuverLocation: p3, distanceMeters: 0, durationSeconds: 0, maneuverType: 'arrive', maneuverModifier: null, streetName: null, exit: null },
  ],
};

describe('NavigationEngine', () => {
  const engine = new NavigationEngine(route, config);

  it('reports the upcoming maneuver from the start of the route', () => {
    const pr = engine.computeProgress(p0);
    expect(pr.currentStepIndex).toBe(0);
    expect(pr.upcomingStep?.maneuverType).toBe('turn');
    expect(pr.remainingDistanceMeters).toBeCloseTo(total, 0);
    expect(pr.isOffRoute).toBe(false);
    expect(pr.hasArrived).toBe(false);
  });

  it('switches to the next maneuver after passing the turn point', () => {
    // Midway between p1 and p2 → still on step 0, upcoming is the turn.
    const before = engine.computeProgress({ latitude: 40, longitude: 0.0045 });
    expect(before.currentStepIndex).toBe(0);
    expect(before.upcomingStep?.maneuverType).toBe('turn');

    // Midway between p2 and p3 → now on step 1, upcoming is arrive.
    const after = engine.computeProgress({ latitude: 40, longitude: 0.0075 });
    expect(after.currentStepIndex).toBe(1);
    expect(after.upcomingStep?.maneuverType).toBe('arrive');
  });

  it('detects off-route when far from the polyline', () => {
    const pr = engine.computeProgress({ latitude: 40.01, longitude: 0.0045 }); // ~1.1 km north
    expect(pr.isOffRoute).toBe(true);
    expect(pr.distanceToRouteMeters).toBeGreaterThan(config.offRouteThresholdMeters);
  });

  it('stays on-route for small GPS noise within the threshold', () => {
    const pr = engine.computeProgress({ latitude: 40.0002, longitude: 0.0045 }); // ~22 m off
    expect(pr.isOffRoute).toBe(false);
  });

  it('flags arrival within the arrival radius', () => {
    const pr = engine.computeProgress(p3);
    expect(pr.hasArrived).toBe(true);
  });

  it('enforces forward-only progress via minTravelledMeters', () => {
    const pr = engine.computeProgress(p0, total * 0.8);
    expect(pr.travelledMeters).toBeGreaterThanOrEqual(total * 0.8);
  });

  it('distance to next maneuver shrinks as the driver advances', () => {
    const near = engine.computeProgress(p0).distanceToNextManeuverMeters;
    const closer = engine.computeProgress(p1).distanceToNextManeuverMeters;
    expect(closer).toBeLessThan(near);
  });
});
