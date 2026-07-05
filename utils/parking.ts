import { OsmParking } from '../types/parking';

// ─── OSM parking tag helpers ──────────────────────────────────────────────────
// Shared so the marker, the free/paid filter, the suggestion card and the
// bottom sheet all classify a spot the exact same way — a single source of
// truth for "is this paid?" and "what do we call it?".

/**
 * True when OSM tags indicate the parking charges a fee.
 * Recognised signals: `fee=yes`, `fee=paid`, or `parking:fee=yes`.
 * Everything else (including `fee=no` and untagged) is treated as free.
 */
export function isPaidParking(tags: Record<string, string>): boolean {
  const fee = tags.fee ?? tags['parking:fee'];
  return fee === 'yes' || fee === 'paid';
}

/** Display name for a parking spot, preferring English, falling back to a label. */
export function parkingName(p: OsmParking): string {
  return p.tags.name ?? p.tags['name:en'] ?? p.tags['name:ru'] ?? 'Parking';
}
