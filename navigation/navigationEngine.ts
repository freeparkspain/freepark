import { LatLng } from '../types/parking';
import {
  NavigationConfig,
  NavigationProgress,
  NavigationRoute,
  NavigationStep,
} from '../types/navigation';
import { haversineDistance } from '../utils/geo';
import { cumulativeDistances, projectOnPath } from './geometry';

// ─── NavigationEngine (pure, framework-free) ──────────────────────────────────
// Given a route + config, turns a raw GPS position into everything the UI and
// voice need: progress along the polyline, the upcoming maneuver, distances,
// remaining time, off-route status and arrival. No React/Activity/Context — it
// is a plain object so it can be exercised entirely from unit tests.
//
// Maneuver switching is driven by ALONG-PATH progress, not by raw distance to a
// maneuver coordinate — the latter misfires on parallel roads where a maneuver
// point can be metres away yet belong to a different segment.

export class NavigationEngine {
  private readonly cumPoints: number[];
  /** Along-route distance at which each step's maneuver occurs. */
  private readonly stepStart: number[];
  private readonly destination: LatLng;

  constructor(
    private readonly route: NavigationRoute,
    private readonly config: NavigationConfig,
  ) {
    this.cumPoints = cumulativeDistances(route.points);
    this.destination = route.points[route.points.length - 1];

    this.stepStart = new Array(route.steps.length);
    let acc = 0;
    for (let i = 0; i < route.steps.length; i++) {
      this.stepStart[i] = acc;
      acc += route.steps[i].distanceMeters;
    }
  }

  get totalDistanceMeters(): number {
    return this.route.totalDistanceMeters;
  }

  /**
   * Compute progress for `location`. `minTravelledMeters` (optional) enforces
   * forward-only progress: pass the previous tick's travelled distance so a
   * momentary GPS snap onto an earlier parallel segment can't rewind the
   * maneuver sequence.
   */
  computeProgress(location: LatLng, minTravelledMeters = 0): NavigationProgress {
    const proj = projectOnPath(location, this.route.points, this.cumPoints);
    const travelled = Math.max(proj.alongMeters, minTravelledMeters);

    const total = this.route.totalDistanceMeters;
    const remainingDistance = Math.max(0, total - travelled);
    const remainingDuration =
      total > 0 ? this.route.totalDurationSeconds * (remainingDistance / total) : 0;

    const { currentStepIndex, upcomingStep, distanceToNextManeuver } =
      this.resolveManeuver(travelled);

    const straightToDestination = haversineDistance(location, this.destination);
    const hasArrived =
      remainingDistance <= this.config.destinationArrivalRadiusMeters ||
      straightToDestination <= this.config.destinationArrivalRadiusMeters;

    const isOffRoute = proj.distanceMeters > this.config.offRouteThresholdMeters;

    return {
      currentStepIndex,
      upcomingStep,
      distanceToNextManeuverMeters: distanceToNextManeuver,
      remainingDistanceMeters:  remainingDistance,
      remainingDurationSeconds: remainingDuration,
      distanceToRouteMeters:    proj.distanceMeters,
      snappedPosition:          proj.snapped,
      travelledMeters:          travelled,
      isOffRoute,
      hasArrived,
    };
  }

  /**
   * Resolve which step the driver is on and what maneuver is next, from the
   * along-route distance travelled. The "current instruction" the UI shows is
   * the UPCOMING step's maneuver (e.g. while on step i you're approaching the
   * turn that begins step i+1).
   */
  private resolveManeuver(travelled: number): {
    currentStepIndex: number;
    upcomingStep: NavigationStep | null;
    distanceToNextManeuver: number;
  } {
    const steps = this.route.steps;
    let i = 0;
    while (i + 1 < steps.length && this.stepStart[i + 1] <= travelled) i++;

    const upcomingIndex = i + 1;
    if (upcomingIndex >= steps.length) {
      // Past the last maneuver — effectively arriving.
      return {
        currentStepIndex: i,
        upcomingStep: steps[steps.length - 1] ?? null,
        distanceToNextManeuver: 0,
      };
    }

    return {
      currentStepIndex: i,
      upcomingStep: steps[upcomingIndex],
      distanceToNextManeuver: Math.max(0, this.stepStart[upcomingIndex] - travelled),
    };
  }
}
