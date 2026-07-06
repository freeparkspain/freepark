import { CarAnimationConfig } from '../../types/navigation';

// ─── Car movement animation helpers (pure) ────────────────────────────────────

/**
 * Duration for animating the car from its current displayed position to the new
 * matched target. Aims to match the real time elapsed between GPS samples (so
 * motion is continuous, not stuttery), clamped to sane bounds. Falls back to a
 * distance-derived guess when the timestamp delta is missing/invalid.
 */
export function computeAnimationDurationMs(
  distanceMeters: number,
  dtMs: number,
  config: CarAnimationConfig,
): number {
  let base = dtMs;
  if (!Number.isFinite(dtMs) || dtMs <= 0) {
    // ~12 m/s assumption → ms; keeps a lone update from snapping or crawling.
    base = (distanceMeters / 12) * 1000;
  }
  return Math.max(config.minimumDurationMs, Math.min(config.maximumDurationMs, base));
}

/**
 * True when the gap is so large the car should teleport rather than glide
 * (initial fix, GPS recovery after a dropout, or a big jump).
 */
export function isLargeJump(distanceMeters: number, config: CarAnimationConfig): boolean {
  return distanceMeters > config.immediateJumpThresholdMeters;
}
