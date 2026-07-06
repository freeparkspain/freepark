import { LatLng } from '../../types/parking';

// ─── Bearing math (pure, framework-free) ──────────────────────────────────────
// Compass bearings in degrees, 0 = north, clockwise. All helpers are unit-tested.

/** Wrap any angle into [0, 360). */
export function normalizeBearing(value: number): number {
  return ((value % 360) + 360) % 360;
}

/**
 * Signed shortest angular delta from `from` to `to`, in (-180, 180].
 * 350 → 10 yields +20 (not -340), so rotation always takes the short path.
 */
export function shortestBearingDelta(from: number, to: number): number {
  return ((to - from + 540) % 360) - 180;
}

/** Initial great-circle bearing from a to b (degrees, 0 = north). */
export function bearingBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const toDeg = (r: number) => (r * 180) / Math.PI;
  const φ1 = toRad(a.latitude);
  const φ2 = toRad(b.latitude);
  const Δλ = toRad(b.longitude - a.longitude);
  const y = Math.sin(Δλ) * Math.cos(φ2);
  const x = Math.cos(φ1) * Math.sin(φ2) - Math.sin(φ1) * Math.cos(φ2) * Math.cos(Δλ);
  return normalizeBearing(toDeg(Math.atan2(y, x)));
}

/** Bearing of the segment a→b (alias for readability at call sites). */
export const segmentBearing = bearingBetween;

/**
 * Move `current` toward `target` by at most `maxStepDeg`, along the shortest
 * angular path. Used to damp rotation so GPS jitter doesn't spin the car.
 */
export function stepBearing(current: number, target: number, maxStepDeg: number): number {
  const delta = shortestBearingDelta(current, target);
  if (Math.abs(delta) <= maxStepDeg) return normalizeBearing(target);
  return normalizeBearing(current + Math.sign(delta) * maxStepDeg);
}

/**
 * Choose the display bearing for this tick using the documented priority:
 *   1. matched route-segment bearing (when snapped to the road)
 *   2. reliable GPS heading (only above a speed threshold)
 *   3. bearing between the last two matched positions (if moved enough)
 *   4. the last stable bearing (e.g. while stationary)
 * Also rejects unrealistic ~180° flips at low speed (GPS noise).
 */
export function resolveTravelBearing(params: {
  snapped: boolean;
  segmentBearing: number;
  gpsBearing: number | null;
  speedMps: number | null;
  prevMatched: LatLng | null;
  currentMatched: LatLng;
  lastStable: number;
  minReliableSpeedMps: number;
}): number {
  const {
    snapped, segmentBearing: segB, gpsBearing, speedMps,
    prevMatched, currentMatched, lastStable, minReliableSpeedMps,
  } = params;

  const moving = speedMps != null && speedMps >= minReliableSpeedMps;

  // Stationary: hold the last stable heading (don't spin in place).
  if (!moving && !snapped) return lastStable;

  let candidate: number;
  if (snapped) {
    candidate = segB;
  } else if (moving && gpsBearing != null) {
    candidate = gpsBearing;
  } else if (prevMatched) {
    candidate = bearingBetween(prevMatched, currentMatched);
  } else {
    candidate = lastStable;
  }

  // Reject a sudden near-reversal unless we're genuinely moving fast — it's
  // almost always GPS noise at low speed.
  if (!moving && Math.abs(shortestBearingDelta(lastStable, candidate)) > 150) {
    return lastStable;
  }
  return normalizeBearing(candidate);
}
