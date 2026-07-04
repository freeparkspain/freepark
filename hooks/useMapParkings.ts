import { useState, useRef, useCallback, useEffect } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Region } from 'react-native-maps';
import { fetchParkingData, fetchParkingGeometryBatch } from '../services/overpassService';
import { OsmParking } from '../types/parking';
import { deltaToZoom } from '../utils/geo';

export type { OsmParking } from '../types/parking';

// ─── Tuning constants ─────────────────────────────────────────────────────────

const DEBOUNCE_MS        = 500;   // quiet time after last move before firing
// zoom 12 matches MALAGA_REGION's own initial view exactly — low enough that
// spots load on first launch (the old MIN_ZOOM=14 silently skipped that fetch,
// which was the real "parkings load so slowly" cause), but no lower: each step
// down roughly doubles the queried area and the result count, and a wider net
// here is what was overwhelming the JS thread (parsing, caching, clustering)
// and presenting as freezes/crashes. Zooming in past 12 still fetches more
// detail for that area as usual — this only bounds how wide the *widest* shot
// can be.
const MIN_ZOOM           = 12;
const COVERAGE_THRESHOLD = 0.40;  // skip network fetch if ≥40% of viewport is
                                  // already covered by session-fetched rectangles
const COOLDOWN_MS        = 5_000; // back-off window after HTTP 429

const GEOMETRY_DEBOUNCE_MS = 350; // quiet time before batching visible-zone geometry requests
const GEOMETRY_BATCH_LIMIT = 40;  // a close-zoom (≤2 km) viewport rarely holds more zones than this

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

// `JSON.stringify` over the whole cache (now including full zone polygon
// rings) plus the AsyncStorage write are heavy, main-thread-blocking work.
// Calling this straight from every merge — which now happens far more often
// thanks to the driver-position auto-load — meant back-to-back multi-hundred-
// ms freezes that compounded into the app feeling like it hung/crashed.
// Debouncing collapses any burst of merges into a single write of the final
// state once things settle, instead of repeating the same heavy snapshot
// write over and over for each intermediate step.
const PERSIST_DEBOUNCE_MS = 2_000;
let persistTimer: ReturnType<typeof setTimeout> | null = null;

/** Debounced, fire-and-forget: persist the current allParkings snapshot. */
function persistCache(): void {
  if (persistTimer) clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    persistTimer = null;
    AsyncStorage.setItem(
      STORAGE_KEY,
      JSON.stringify(Array.from(allParkings.values())),
    ).catch(err => console.warn('[useMapParkings] storage write:', err));
  }, PERSIST_DEBOUNCE_MS);
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

  // Batched on-demand geometry for zones visible at close zoom — independent
  // debounce/abort/dedupe so it never interferes with the region-fetch above.
  const geometryTimer     = useRef<ReturnType<typeof setTimeout> | null>(null);
  const geometryAbortCtrl = useRef<AbortController | null>(null);
  const geometryRequested = useRef<Set<string>>(new Set());

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
          // Register the bounding box of the restored spots as already-fetched
          // so the first region change after cold start doesn't re-fetch areas
          // we already have full data for.
          //
          // First compute centroid, then filter spots within 1° of it to discard
          // OSM parsing artefacts (position {lat:0, lon:0}) that would otherwise
          // bloat the span and make the coverage bbox useless.
          let sumLat = 0, sumLon = 0;
          for (const p of stored) { sumLat += p.position.latitude; sumLon += p.position.longitude; }
          const cLat = sumLat / stored.length;
          const cLon = sumLon / stored.length;

          let s = 90, w = 180, n = -90, e = -180, cleanCount = 0;
          for (const p of stored) {
            const { latitude, longitude } = p.position;
            if (Math.abs(latitude - cLat) > 1.0 || Math.abs(longitude - cLon) > 1.0) continue;
            if (latitude  < s) s = latitude;
            if (latitude  > n) n = latitude;
            if (longitude < w) w = longitude;
            if (longitude > e) e = longitude;
            cleanCount++;
          }
          if (cleanCount >= 10) {
            const pad = 0.05;
            fetchedRects.push({ south: s - pad, west: w - pad, north: n + pad, east: e + pad });
            console.log(`[useMapParkings] registered coverage bbox from ${cleanCount} spots`);
          }

          // Defer the initial render of persisted markers until after any
          // in-progress gesture so the first map interaction never hiccups.
          InteractionManager.runAfterInteractions(() => {
            setParkings(Array.from(allParkings.values()));
          });
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

      // Mark this bbox as "in-flight / attempted" BEFORE the network call.
      // If the fetch fails (mirror down, timeout), the bbox stays recorded so
      // subsequent pans over the same area don't immediately queue another
      // doomed attempt — which was the cause of the 40+ "0% cached" storm.
      fetchedRects.push(newBox);

      setLoading(true);
      try {
        const data = await fetchParkingData(south, west, north, east, ctrl.signal);

        console.log(`[useMapParkings] received ${data.length} elements from API`);

        const added = mergeIntoCache(data);
        console.log(
          `[useMapParkings] +${added} new  |  ${allParkings.size} total in session cache`,
        );

        // Only push to React state when genuinely new spots arrived — an
        // unnecessary setParkings rebuilds the Supercluster index (O(n log n))
        // and reconciles all visible markers for no visual gain, which was the
        // main cause of the flickering / "icon jump" during normal browsing.
        if (added > 0) {
          setParkings(Array.from(allParkings.values()));
          persistCache();
        }

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

  // ── On-demand zone geometry (batched) ─────────────────────────────────────
  // MapScreen calls this with the ids of the zones currently on screen once
  // the camera is close enough to show outlines. Debounced so rapid pans only
  // produce one request, deduped against ids already requested or already
  // carrying geometry, and capped per-batch to keep each query small and fast.
  const loadZoneGeometry = useCallback((ids: string[]) => {
    const pending = ids
      .filter(id => {
        if (id.startsWith('n') || geometryRequested.current.has(id)) return false;
        const p = allParkings.get(id);
        return !!p && !p.polygon && !p.polyline;
      })
      .slice(0, GEOMETRY_BATCH_LIMIT);

    if (pending.length === 0) return;

    if (geometryTimer.current) clearTimeout(geometryTimer.current);
    geometryTimer.current = setTimeout(async () => {
      pending.forEach(id => geometryRequested.current.add(id));

      geometryAbortCtrl.current?.abort();
      const ctrl = new AbortController();
      geometryAbortCtrl.current = ctrl;

      try {
        const results = await fetchParkingGeometryBatch(pending, ctrl.signal);
        if (results.size === 0) return;

        let changed = false;
        for (const [id, geom] of results) {
          const existing = allParkings.get(id);
          if (existing && (geom.polygon || geom.polyline)) {
            allParkings.set(id, { ...existing, polygon: geom.polygon, polyline: geom.polyline });
            changed = true;
          }
        }
        if (changed) {
          setParkings(Array.from(allParkings.values()));
          persistCache();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        console.warn('[useMapParkings] zone geometry batch error:', err);
      }
    }, GEOMETRY_DEBOUNCE_MS);
  }, []);

  return { parkings, loading, loadForRegion, loadZoneGeometry };
};
