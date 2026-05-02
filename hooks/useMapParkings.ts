import { useState, useRef, useCallback } from 'react';
import { Region } from 'react-native-maps';
import { fetchParkingData } from '../services/overpassService';
import { OsmParking, LatLng } from '../types/parking';
import { deltaToZoom, haversineDistance } from '../utils/geo';

export type { OsmParking } from '../types/parking';

// ─── Tuning constants ─────────────────────────────────────────────────────────

const DEBOUNCE_MS      = 1_000;  // quiet time after last move before firing
const CACHE_PREC       = 3;      // bbox key decimal places (~111 m per unit)
const MIN_ZOOM         = 12;     // below this zoom Overpass returns too many results
const MIN_FETCH_DIST_M = 500;    // ignore pans shorter than 500 m …
const ZOOM_CHANGE_FRAC = 0.20;   // … unless zoom changed by ≥ 20 %
const COOLDOWN_MS      = 5_000;  // back-off after HTTP 429

// ─── Module-level persistent caches ──────────────────────────────────────────
// Declared outside the hook so they survive component re-mounts.
// If MapScreen unmounts (e.g. navigation push) and comes back, the cache is
// already warm — no network call needed and markers appear instantly.

/** Bbox keys we have already fetched. Prevents duplicate requests. */
const fetchedBboxes = new Set<string>();

/**
 * Every parking ever loaded in this session, keyed by OSM ID.
 * New fetches merge into this map — entries are never removed.
 * This means panning back to a previously visited area shows cached markers
 * immediately, without a spinner or an API call.
 */
const allParkings = new Map<string, OsmParking>();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function regionToBounds(r: Region) {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

function regionToKey(r: Region): string {
  const { south, west, north, east } = regionToBounds(r);
  const f = (n: number) => n.toFixed(CACHE_PREC);
  return `${f(south)},${f(west)},${f(north)},${f(east)}`;
}

function regionCenter(r: Region): LatLng {
  return { latitude: r.latitude, longitude: r.longitude };
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useMapParkings = () => {
  // On re-mount, pre-populate from the persistent cache so the map is never blank
  const [parkings, setParkings] = useState<OsmParking[]>(() =>
    Array.from(allParkings.values()),
  );
  const [loading,  setLoading]  = useState(false);

  // Per-instance rate-limiting state — refs so mutations never cause re-renders
  const debounceTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortCtrl         = useRef<AbortController | null>(null);
  const cooldownUntil     = useRef<number>(0);
  const lastFetchCenter   = useRef<LatLng | null>(null);
  const lastFetchLatDelta = useRef<number>(0);

  const loadForRegion = useCallback((region: Region) => {

    // ── 1. Debounce ───────────────────────────────────────────────────────────
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(async () => {

      // ── 2. Zoom guard ─────────────────────────────────────────────────────
      // Do NOT wipe markers when zooming out — they stay visible so the user
      // can see where they've already explored.
      if (deltaToZoom(region.latitudeDelta) < MIN_ZOOM) return;

      // ── 3. Cooldown guard (back-off after 429) ────────────────────────────
      if (Date.now() < cooldownUntil.current) return;

      // ── 4. Minimum distance guard ─────────────────────────────────────────
      const centre = regionCenter(region);
      if (lastFetchCenter.current && lastFetchLatDelta.current > 0) {
        const distM     = haversineDistance(lastFetchCenter.current, centre);
        const zoomShift = Math.abs(region.latitudeDelta - lastFetchLatDelta.current)
                          / lastFetchLatDelta.current;
        if (distM < MIN_FETCH_DIST_M && zoomShift < ZOOM_CHANGE_FRAC) return;
      }

      // ── 5. Bbox cache ─────────────────────────────────────────────────────
      // If we've already fetched this exact tile, all its parkings are already
      // in `allParkings` (and therefore in state). Nothing to do.
      const key = regionToKey(region);
      if (fetchedBboxes.has(key)) return;

      // ── 6. Cancel previous in-flight request ─────────────────────────────
      abortCtrl.current?.abort();
      const ctrl = new AbortController();
      abortCtrl.current = ctrl;

      lastFetchCenter.current   = centre;
      lastFetchLatDelta.current = region.latitudeDelta;

      // ── 7. Fetch ──────────────────────────────────────────────────────────
      const { south, west, north, east } = regionToBounds(region);
      console.log(
        `[useMapParkings] fetching bbox: S=${south.toFixed(4)} W=${west.toFixed(4)} N=${north.toFixed(4)} E=${east.toFixed(4)}`,
      );

      setLoading(true);
      try {
        const data = await fetchParkingData(south, west, north, east, ctrl.signal);

        console.log(`[useMapParkings] received ${data.length} elements from API`);
        if (data.length === 0) {
          console.warn('[useMapParkings] 0 results — check bbox coordinates and query tags');
        }

        // Mark bbox as done BEFORE merging (guards against re-entrant calls)
        fetchedBboxes.add(key);

        // Merge: add only genuinely new entries; never overwrite existing ones
        let added = 0;
        for (const p of data) {
          if (!allParkings.has(p.id)) {
            allParkings.set(p.id, p);
            added++;
          }
        }
        console.log(
          `[useMapParkings] +${added} new  |  ${allParkings.size} total in session cache`,
        );

        // Derive the array once and push it to React state
        setParkings(Array.from(allParkings.values()));

      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;

        if (err instanceof Error && err.message.includes('HTTP 429')) {
          cooldownUntil.current = Date.now() + COOLDOWN_MS;
          console.warn('[useMapParkings] 429 rate-limited — pausing 5 s');
        } else {
          // Transient error: reset centre so the same area can be retried
          lastFetchCenter.current = null;
          console.warn('[useMapParkings] fetch error:', err);
        }
        // Keep existing markers on screen — never call setParkings([])

      } finally {
        if (abortCtrl.current === ctrl) setLoading(false);
      }

    }, DEBOUNCE_MS);
  }, []);

  return { parkings, loading, loadForRegion };
};
