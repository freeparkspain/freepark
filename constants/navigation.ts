import {
  CarAnimationConfig,
  CarTrackingConfig,
  NavigationCameraConfig,
  NavigationConfig,
  RoutingConfig,
} from '../types/navigation';

// ─── Routing endpoint ─────────────────────────────────────────────────────────
// PUBLIC OSRM is for development/testing ONLY (see README). Override the base
// URL with EXPO_PUBLIC_OSRM_BASE_URL to point at your own OSRM deployment — no
// call site changes needed. Must be HTTPS.
const DEFAULT_OSRM_BASE_URL = 'https://router.project-osrm.org';

export const ROUTING_CONFIG: RoutingConfig = {
  baseUrl:          process.env.EXPO_PUBLIC_OSRM_BASE_URL ?? DEFAULT_OSRM_BASE_URL,
  requestTimeoutMs: 15_000,
};

// ─── Navigation tuning ────────────────────────────────────────────────────────

export const NAVIGATION_CONFIG: NavigationConfig = {
  offRouteThresholdMeters:        50,
  offRouteConfirmationsRequired:  3,
  rerouteCooldownMillis:          10_000,
  destinationArrivalRadiusMeters: 25,
  maxUsableAccuracyMeters:        40,
};

// ─── Voice guidance distances (metres before the maneuver) ────────────────────
// Staged pre-announcements; the manager de-dupes per (step, stage) and skips
// stages that don't fit between two close maneuvers. Adapted to speed at call
// time (faster driving → announce earlier).
export const VOICE_STAGE_DISTANCES_M = [500, 200, 50] as const;

/** Below this distance to the maneuver, announce the maneuver itself ("now"). */
export const VOICE_IMMEDIATE_DISTANCE_M = 30;

/** How far ahead (seconds of travel) the earliest prompt should aim for. */
export const VOICE_LOOKAHEAD_SECONDS = 20;

// ─── Car marker / camera tuning ───────────────────────────────────────────────

export const CAR_ANIMATION_CONFIG: CarAnimationConfig = {
  minimumDurationMs:            250,
  maximumDurationMs:            1_200,
  immediateJumpThresholdMeters: 150,
};

export const CAR_TRACKING_CONFIG: CarTrackingConfig = {
  maximumSnapDistanceMeters:     35,
  maximumBackwardProgressMeters: 20,
  searchSegmentsBehind:          15,
  searchSegmentsAhead:           100,
  minReliableSpeedMps:           1.5, // ~5.4 km/h — below this, ignore GPS heading
};

export const NAVIGATION_CAMERA_CONFIG: NavigationCameraConfig = {
  // Comfortable base driving zoom for city speed; drivingZoom() zooms out
  // further as speed rises so more road ahead is visible.
  zoom:                        16.5,
  // Flat 2D navigation (no 3D tilt) — reads like a professional 2D map. The map
  // still rotates to the travel heading; only the pitch is removed.
  pitch:                       0,
  carVerticalPositionRatio:    0.7,
  animationDurationMs:         500,
  minimumPositionUpdateMeters: 2,
  minimumBearingUpdateDegrees: 3,
};
