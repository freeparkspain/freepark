import { OsmParking } from '../types/parking';

// ─── OSM parking tag helpers ──────────────────────────────────────────────────
// Shared so the marker, the free/paid filter, the suggestion card and the
// bottom sheet all classify a spot the exact same way — a single source of
// truth for "is this paid?" and "what do we call it?".

export type ParkingFeeStatus = 'free' | 'paid' | 'unknown';

/** Absence of an OSM fee tag means unknown, never implicitly free. */
export function parkingFeeStatus(tags: Record<string, string>): ParkingFeeStatus {
  const fee = (tags.fee ?? tags['parking:fee'])?.toLowerCase();
  if (fee === 'yes' || fee === 'paid') return 'paid';
  if (fee === 'no' || fee === 'free') return 'free';
  return 'unknown';
}

/** Compatibility helper for paid styling. Unknown remains visually neutral/free-like. */
export function isPaidParking(tags: Record<string, string>): boolean {
  return parkingFeeStatus(tags) === 'paid';
}

export function isFreeParking(tags: Record<string, string>): boolean {
  return parkingFeeStatus(tags) === 'free';
}

export function isRestrictedParking(tags: Record<string, string>): boolean {
  const access = (tags.motor_vehicle ?? tags.vehicle ?? tags.access)?.toLowerCase();
  return access === 'no' || access === 'private' || access === 'customers'
    || access === 'permit' || access === 'residents';
}

/** Display name for a parking spot, preferring English, falling back to a label. */
export function parkingName(p: OsmParking): string {
  return p.tags.name ?? p.tags['name:en'] ?? p.tags['name:ru'] ?? 'Parking';
}
