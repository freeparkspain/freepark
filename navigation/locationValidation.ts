import { LocationSample } from '../types/navigation';
import { isValidCoordinate } from './services/routeValidator';

/** A current-position result older than this is unsafe for route origin. */
export const MAX_INITIAL_LOCATION_AGE_MS = 120_000;

/** Runtime guard for native/fake provider samples before they reach the engine. */
export function isValidLocationSample(value: unknown): value is LocationSample {
  if (!value || typeof value !== 'object') return false;
  const sample = value as Partial<LocationSample>;
  return (
    isValidCoordinate(sample.position) &&
    isNullableNonNegativeFinite(sample.accuracyMeters) &&
    isNullableNonNegativeFinite(sample.speedMps) &&
    isNullableBearing(sample.bearingDegrees) &&
    typeof sample.timestampMs === 'number' &&
    Number.isFinite(sample.timestampMs) &&
    sample.timestampMs > 0
  );
}

export function isFreshLocationSample(
  sample: LocationSample,
  nowMs: number,
  maximumAgeMs = MAX_INITIAL_LOCATION_AGE_MS,
): boolean {
  if (!isValidLocationSample(sample) || !Number.isFinite(nowMs)) return false;
  // A small future allowance protects against clock rounding/skew while still
  // rejecting corrupt timestamps.
  const ageMs = nowMs - sample.timestampMs;
  return ageMs >= -5_000 && ageMs <= maximumAgeMs;
}

function isNullableNonNegativeFinite(value: unknown): boolean {
  return value === null || (
    typeof value === 'number' && Number.isFinite(value) && value >= 0
  );
}

function isNullableBearing(value: unknown): boolean {
  return value === null || (
    typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 360
  );
}
