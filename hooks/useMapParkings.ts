import { useState, useRef, useCallback, useEffect } from 'react';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Region } from 'react-native-maps';
import { fetchParkingData } from '../services/overpassService';
import { OsmParking } from '../types/parking';
import { deltaToZoom } from '../utils/geo';

export type { OsmParking } from '../types/parking';

// ─── Tuning constants ─────────────────────────────────────────────────────────

const DEBOUNCE_MS        = 800;   // quiet time after last move before firing
const MIN_ZOOM           = 14;    // zoom 14 ≈ 0.022° delta (neighbourhood level)
const COVERAGE_THRESHOLD = 0.40;  // skip network fetch if ≥40% of viewport is
                                  // already covered by session-fetched rectangles
const COOLDOWN_MS        = 5_000; // back-off window after HTTP 429

// ─── Persistence ─────────────────────────────────────────────────────────────

/** AsyncStorage key — bump the suffix when the OsmParking shape changes. */
const STORAGE_KEY = 'freepark_v1_parkings';

// ─── Types ────────────────────────────────────────────────────────────────────

type BBox4 = { south: number; west: number; north: number; east: number };

// ─── Module-level session caches ─────────────────────────────────────────────
// Survive component re-mounts within a single app session.

/** Every viewport rectangle successfully fetched from Overpass this session. */
const fetchedRects: BBox4[] = [];

/**
 * Every parking ever loaded (network + storage), keyed by OSM ID.
 * Entries are never removed — the cache only grows.
 */
const allParkings = new Map<string, OsmParking>();

/**
 * Guards the one-time AsyncStorage load so it runs exactly once per JS
 * process lifetime, even if the hook mounts and unmounts multiple times.
 */
let storageLoaded = false;

// ─── Spatial helpers ──────────────────────────────────────────────────────────

function bboxArea(b: BBox4): number {
  return Math.max(0, b.east - b.west) * Math.max(0, b.north - b.south);
}

function intersectBbox(a: BBox4, b: BBox4): BBox4 | null {
  const south = Math.max(a.south, b.south);
  const west  = Math.max(a.west,  b.west);
  const north = Math.min(a.north, b.north);
  const east  = Math.min(a.east,  b.east);
  return south < north && west < east ? { south, west, north, east } : null;
}

/**
 * Fraction of `target` already covered by the union of `rects`.
 * Sums pairwise intersections (O(n)); caps at 1.0 to absorb double-counting
 * when fetched rectangles overlap each other.
 */
function coveredFraction(target: BBox4, rects: BBox4[]): number {
  const total = bboxArea(target);
  if (total <= 0 || rects.length === 0) return 0;
  let covered = 0;
  for (const r of rects) {
    const ix = intersectBbox(target, r);
    if (ix) covered += bboxArea(ix);
  }
  return Math.min(1, covered / total);
}

/** True if every corner of `target` lies inside at least one fetched rect. */
function isContainedInAny(target: BBox4, rects: BBox4[]): boolean {
  return rects.some(
    r =>
      target.south >= r.south &&
      target.west  >= r.west  &&
      target.north <= r.north &&
      target.east  <= r.east,
  );
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function regionToBBox(r: Region): BBox4 {
  return {
    south: r.latitude  - r.latitudeDelta  / 2,
    west:  r.longitude - r.longitudeDelta / 2,
    north: r.latitude  + r.latitudeDelta  / 2,
    east:  r.longitude + r.longitudeDelta / 2,
  };
}

// ─── Persistence helpers ──────────────────────────────────────────────────────

/** Merge `items` into `allParkings`; returns count of genuinely new entries. */
function mergeIntoCache(items: OsmParking[]): number {
  let added = 0;
  for (const p of items) {
    if (!allParkings.has(p.id)) {
      allParkings.set(p.id, p);
      added++;
    }
  }
  return added;
}

/** Fire-and-forget: persist the current allParkings snapshot to AsyncStorage. */
function persistCache(): void {
  AsyncStorage.setItem(
    STORAGE_KEY,
    JSON.stringify(Array.from(allParkings.values())),
  ).catch(err => console.warn('[useMapParkings] storage write:', err));
}

// ─── Hook ─────────────────────────────────────────────────────────────────────

export const useMapParkings = () => {
  // Pre-populate from the in-memory cache on every mount (instant if warm).
  const [parkings, setParkings] = useState<OsmParking[]>(() =>
    Array.from(allParkings.values()),
  );
  const [loading, setLoading] = useState(false);

  const debounceTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const abortCtrl     = useRef<AbortController | null>(null);
  const cooldownUntil = useRef<number>(0);

  // ── AsyncStorage hydration ─────────────────────────────────────────────────
  // Runs once per JS process (storageLoaded flag).  Loads the persisted
  // snapshot into allParkings so the user sees all previously discovered
  // parkings the instant the map mounts, before any network request fires.
  useEffect(() => {
    if (storageLoaded) return;
    storageLoaded = true;

    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (!raw) return;
        const stored: OsmParking[] = JSON.parse(raw);
        const added = mergeIntoCache(stored);
        if (added > 0) {
          setParkings(Array.from(allParkings.values()));
          console.log(`[useMapParkings] hydrated ${added} spots from AsyncStorage`);
        }
      })
      .catch(err => console.warn('[useMapParkings] storage read:', err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Region fetch ──────────────────────────────────────────────────────────
  const loadForRegion = useCallback((region: Region) => {

    // ── 1. Debounce ─────────────────────────────────────────────────────────
    if (debounceTimer.current) clearTimeout(debounceTimer.current);

    debounceTimer.current = setTimeout(async () => {

      // ── 2. Zoom guard ──────────────────────────────────────────────────────
      if (deltaToZoom(region.latitudeDelta) < MIN_ZOOM) {
        console.log(
          `[useMapParkings] zoom ${deltaToZoom(region.latitudeDelta)} < ${MIN_ZOOM} — skipping`,
        );
        return;
      }

      // ── 3. Cooldown guard ──────────────────────────────────────────────────
      if (Date.now() < cooldownUntil.current) return;

      const newBox = regionToBBox(region);

      // ── 4. Containment check (fast path) ───────────────────────────────────
      if (isContainedInAny(newBox, fetchedRects)) {
        console.log('[useMapParkings] viewport fully contained in session cache — skipping');
        return;
      }

      // ── 5. Coverage check — skip if ≥40% already fetched ──────────────────
      // A lower threshold than before (was 80%) because persisted storage
      // already gives the user rich visual data; we only need the missing 60%+.
      const fraction = coveredFraction(newBox, fetchedRects);
      if (fraction >= COVERAGE_THRESHOLD) {
        console.log(
          `[useMapParkings] ${(fraction * 100).toFixed(0)}% of viewport in session cache — skipping`,
        );
        return;
      }

      // ── 6. Cancel any in-flight request ───────────────────────────────────
      abortCtrl.current?.abort();
      const ctrl = new AbortController();
      abortCtrl.current = ctrl;

      // ── 7. Fetch ───────────────────────────────────────────────────────────
      const { south, west, north, east } = newBox;
      console.log(
        `[useMapParkings] fetching (${(fraction * 100).toFixed(0)}% cached) ` +
        `S=${south.toFixed(4)} W=${west.toFixed(4)} N=${north.toFixed(4)} E=${east.toFixed(4)}`,
      );

      setLoading(true);
      try {
        const data = await fetchParkingData(south, west, north, east, ctrl.signal);

        console.log(`[useMapParkings] received ${data.length} elements from API`);

        // Record the fetched bbox before merging to guard re-entrant calls
        fetchedRects.push(newBox);

        const added = mergeIntoCache(data);
        console.log(
          `[useMapParkings] +${added} new  |  ${allParkings.size} total in session cache`,
        );

        // Push to React state
        const snapshot = Array.from(allParkings.values());
        setParkings(snapshot);

        // Persist the updated cache asynchronously — never blocks the UI
        if (added > 0) persistCache();

      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;

        if (err instanceof Error && err.message.includes('HTTP 429')) {
          cooldownUntil.current = Date.now() + COOLDOWN_MS;
          console.warn('[useMapParkings] 429 rate-limited — pausing 5 s');
        } else {
          console.warn('[useMapParkings] fetch error:', err);
        }

      } finally {
        if (abortCtrl.current === ctrl) setLoading(false);
      }

    }, DEBOUNCE_MS);
  }, []);

  return { parkings, loading, loadForRegion };
};
