// ─── English distance / time / ETA formatting ────────────────────────────────
// Pure, no imports — unit-tested. Navigation-specific (metres / seconds in) so
// it stays independent of utils/geo.ts (which formats km / minutes for the
// parking UI).

/**
 * Distance:
 *   < 1000 m  → "350 m"   (rounded to 10 m below 1 km for a calmer readout)
 *   ≥ 1000 m  → "1.4 km"  (one decimal; whole km above 10)
 */
export function formatDistanceEn(meters: number): string {
  const m = Math.max(0, meters);
  if (m < 1000) {
    const rounded = m < 100 ? Math.round(m) : Math.round(m / 10) * 10;
    return `${rounded} m`;
  }
  const km = m / 1000;
  if (km >= 10) return `${Math.round(km)} km`;
  return `${km.toFixed(1)} km`;
}

/**
 * Duration:
 *   < 60 min → "25 min"
 *   ≥ 60 min → "1 h 20 min"  (minutes omitted when zero: "2 h")
 */
export function formatDurationEn(seconds: number): string {
  const totalMinutes = Math.max(0, Math.round(seconds / 60));
  if (totalMinutes < 60) return `${totalMinutes} min`;
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return m > 0 ? `${h} h ${m} min` : `${h} h`;
}

/**
 * ETA as local device time in 12-hour form, e.g. "4:47 PM", for
 * `now + remainingSeconds`. Injectable `now` keeps it deterministic under test.
 */
export function formatEta(remainingSeconds: number, now: Date = new Date()): string {
  const eta = new Date(now.getTime() + Math.max(0, remainingSeconds) * 1000);
  let hours = eta.getHours();
  const minutes = eta.getMinutes().toString().padStart(2, '0');
  const suffix = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12;
  if (hours === 0) hours = 12;
  return `${hours}:${minutes} ${suffix}`;
}

/** Absolute epoch ms of arrival — stored in state so the UI can re-render live. */
export function etaEpochMs(remainingSeconds: number, now: Date = new Date()): number {
  return now.getTime() + Math.max(0, remainingSeconds) * 1000;
}
