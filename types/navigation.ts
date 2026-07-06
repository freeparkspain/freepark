import { LatLng } from './parking';

// ─── Domain models ────────────────────────────────────────────────────────────
// These are the app's OWN navigation models — deliberately decoupled from the
// OSRM JSON shape (see services/navigation/osrmTypes.ts). Nothing outside the
// OSRM mapper should ever touch the raw API structures.

/** OSRM maneuver `type` values we handle explicitly (others fall back). */
export type ManeuverType =
  | 'depart'
  | 'arrive'
  | 'turn'
  | 'continue'
  | 'merge'
  | 'on ramp'
  | 'off ramp'
  | 'fork'
  | 'end of road'
  | 'roundabout'
  | 'rotary'
  | 'roundabout turn'
  | 'new name'
  | 'notification'
  | 'use lane';

/** OSRM maneuver `modifier` values. */
export type ManeuverModifier =
  | 'left'
  | 'right'
  | 'slight left'
  | 'slight right'
  | 'sharp left'
  | 'sharp right'
  | 'straight'
  | 'uturn';

export interface NavigationStep {
  /** Human-readable, localized (RU) instruction for this maneuver. */
  instruction:     string;
  /** Where the maneuver physically happens (start of this step). */
  maneuverLocation: LatLng;
  /** Length of this step — distance travelled until the NEXT maneuver. */
  distanceMeters:  number;
  durationSeconds: number;
  maneuverType:    string;
  maneuverModifier: string | null;
  streetName:      string | null;
  /** Roundabout/rotary exit number, when OSRM provides one. */
  exit:            number | null;
}

export interface NavigationRoute {
  points:              LatLng[];
  steps:               NavigationStep[];
  totalDistanceMeters: number;
  totalDurationSeconds: number;
}

// ─── Live location sample ─────────────────────────────────────────────────────

export interface LocationSample {
  position:        LatLng;
  /** Horizontal accuracy in metres (null when unknown). */
  accuracyMeters:  number | null;
  /** Course over ground in degrees clockwise from true north (null if unknown). */
  bearingDegrees:  number | null;
  /** Ground speed in m/s (null if unknown). */
  speedMps:        number | null;
  /** Sample timestamp (ms since epoch). */
  timestampMs:     number;
}

// ─── Engine output ────────────────────────────────────────────────────────────

export interface NavigationProgress {
  /** Index of the step the driver is currently travelling along. */
  currentStepIndex:          number;
  /** The upcoming maneuver the UI/voice should announce. */
  upcomingStep:              NavigationStep | null;
  distanceToNextManeuverMeters: number;
  remainingDistanceMeters:   number;
  remainingDurationSeconds:  number;
  /** Perpendicular distance from the driver to the route polyline. */
  distanceToRouteMeters:     number;
  /** Snapped position on the route (nearest point on the polyline). */
  snappedPosition:           LatLng;
  /** Distance travelled along the route so far. */
  travelledMeters:           number;
  isOffRoute:                boolean;
  hasArrived:                boolean;
}

// ─── State machine ────────────────────────────────────────────────────────────

export type NavigationState =
  | { kind: 'idle' }
  | { kind: 'requestingLocation' }
  | { kind: 'buildingRoute' }
  | {
      kind: 'navigating';
      currentInstruction:           string;
      streetName:                   string | null;
      distanceToNextManeuverMeters: number;
      remainingDistanceMeters:      number;
      remainingDurationSeconds:     number;
      etaEpochMs:                   number;
      maneuverType:                 string;
      maneuverModifier:             string | null;
      isMuted:                      boolean;
      isFollowingUser:              boolean;
      isRerouting:                  boolean;
    }
  | { kind: 'arrived'; destination: LatLng }
  | { kind: 'error'; message: string; recoverable: boolean };

// ─── Configuration ────────────────────────────────────────────────────────────

/** Swap the base URL to point at a self-hosted OSRM without touching call sites. */
export interface RoutingConfig {
  baseUrl: string;
  /** Network timeout for a single routing request (ms). */
  requestTimeoutMs: number;
}

export interface NavigationConfig {
  offRouteThresholdMeters:       number;
  offRouteConfirmationsRequired: number;
  rerouteCooldownMillis:         number;
  destinationArrivalRadiusMeters: number;
  /** GPS samples worse than this accuracy are ignored for off-route decisions. */
  maxUsableAccuracyMeters:       number;
}

// ─── Vehicle tracking / camera (car marker feature) ───────────────────────────

/** Result of matching a raw GPS point onto the active route. */
export interface MatchedLocation {
  rawPosition:             LatLng;
  matchedPosition:         LatLng;
  distanceFromRouteMeters: number;
  routeSegmentIndex:       number;
  routeProgressMeters:     number;
  bearing:                 number;
  isSnappedToRoute:        boolean;
}

export type NavigationCameraMode = 'following' | 'free' | 'overview';

export interface CarAnimationConfig {
  minimumDurationMs:            number;
  maximumDurationMs:            number;
  immediateJumpThresholdMeters: number;
}

export interface CarTrackingConfig {
  maximumSnapDistanceMeters:     number;
  maximumBackwardProgressMeters: number;
  searchSegmentsBehind:          number;
  searchSegmentsAhead:           number;
  /** Below this speed (m/s) GPS heading is considered unreliable. */
  minReliableSpeedMps:           number;
}

export interface NavigationCameraConfig {
  zoom:                       number;
  pitch:                      number;
  /** 0..1 — how far down the usable map the car sits (0.7 ≈ 70%). */
  carVerticalPositionRatio:   number;
  animationDurationMs:        number;
  minimumPositionUpdateMeters: number;
  minimumBearingUpdateDegrees: number;
}

/** Measured layout used to place the car below centre without hardcoded pixels. */
export interface MapViewportLayout {
  width:              number;
  height:             number;
  topOverlayHeight:   number;
  bottomOverlayHeight: number;
  safeAreaTop:        number;
  safeAreaBottom:     number;
}

export interface MapEdgePadding {
  top:    number;
  right:  number;
  bottom: number;
  left:   number;
}

/** Structured error surfaced to the UI (message is user-facing, English). */
export class NavigationError extends Error {
  constructor(
    message: string,
    readonly recoverable: boolean = true,
  ) {
    super(message);
    this.name = 'NavigationError';
  }
}
