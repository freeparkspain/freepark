import { useState, useRef, useCallback, useEffect } from 'react';
import { InteractionManager } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Region } from 'react-native-maps';
import { fetchParkingGeometryBatch } from '../services/overpassService';
import { defaultParkingDataProvider } from '../services/parking/parkingDataProvider';
import { OsmParking } from '../types/parking';
import { deltaToZoom } from '../utils/geo';
import { normalizeGeometryForParkingTags } from '../utils/parkingGeometry';
import { PARKING_STORAGE_KEY, registerParkingCacheReset } from '../services/cache/parkingCache';
import {
  MAX_MEMORY_PARKINGS,
  ParkingCacheEntry,
  ParkingCoverage,
  compactCoverage,
  coveredFraction as exactCoveredFraction,
  decodeParkingCache,
  encodeParkingCache,
  isContainedInAny as isExactlyContainedInAny,
  mergeParking,
  validateParkingArray,
} from '../services/cache/parkingCacheModel';

export type { OsmParking } from '../types/parking';

// ─── Tuning constants ─────────────────────────────────────────────────────────

// zoom 12 matches MALAGA_REGION's own initial view exactly — low enough that
// spots load on first launch (the old MIN_ZOOM=14 silently skipped that fetch,
// which was the real "parkings load so slowly" cause), but no lower: each step
// down roughly doubles the queried area and the result count, and a wider net
// here is what was overwhelming the JS thread (parsing, caching, clustering)
// and presenting as freezes/crashes. Zooming in past 12 still fetches more
// detail for that area as usual — this only bounds how wide the *widest* shot
// can be.
const MIN_ZOOM           = 12;
const COVERAGE_THRESHOLD = 0.90;  // only skip when almost the whole viewport is
                                  // already covered by successful exact rectangles
const COOLDOWN_MS        = 5_000; // back-off window after HTTP 429

const GEOMETRY_DEBOUNCE_MS = 350; // quiet time before batching visible-zone geometry requests
const GEOMETRY_BATCH_LIMIT = 18;  // smaller `out geom` batches complete within the geo timeout on flaky mirrors

// ─── Persistence ─────────────────────────────────────────────────────────────

/** AsyncStorage key — shared with the cache module (single source of truth). */
const STORAGE_KEY = PARKING_STORAGE_KEY;

// ─── Types ────────────────────────────────────────────────────────────────────

type BBox4 = { south: number; west: number; north: number; east: number };

// ─── Module-level session caches ─────────────────────────────────────────────
// Survive component re-mounts within a single app session.

/** Every viewport rectangle successfully fetched from Overpass this session. */
const fetchedCoverage: ParkingCoverage[] = [];

/** Bounded, freshness-ordered parking objects keyed by OSM ID. */
const allParkings = new Map<string, OsmParking>();
const parkingUpdatedAt = new Map<string, number>();

/**
 * Guards the one-time AsyncStorage load so it runs exactly once per JS
 * process lifetime, even if the hook mounts and unmounts multiple times.
 */
let storageLoaded = false;
let cacheGeneration = 0;

// ─── Spatial helpers ──────────────────────────────────────────────────────────

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

interface CacheMergeResult {
  added: number;
  changed: number;
  evicted: number;
}

function enforceMemoryLimit(): number {
  if (allParkings.size <= MAX_MEMORY_PARKINGS) return 0;
  const newestIds = Array.from(allParkings.keys())
    .sort((a, b) => (parkingUpdatedAt.get(b) ?? 0) - (parkingUpdatedAt.get(a) ?? 0))
    .slice(0, MAX_MEMORY_PARKINGS);
  const keep = new Set(newestIds);
  let evicted = 0;
  for (const id of Array.from(allParkings.keys())) {
    if (keep.has(id)) continue;
    allParkings.delete(id);
    parkingUpdatedAt.delete(id);
    evicted++;
  }
  // Once markers are evicted, no historical rectangle can honestly promise
  // that every parking from that response is still present in memory.
  fetchedCoverage.length = 0;
  return evicted;
}

/** Upsert fresh provider data while preserving optional geometry already loaded. */
function mergeIntoCache(
  items: OsmParking[],
  updatedAt = Date.now(),
): CacheMergeResult {
  let added = 0;
  let changed = 0;
  for (const parking of items) {
    const existing = allParkings.get(parking.id);
    if (!existing) added++;
    allParkings.set(parking.id, mergeParking(existing, parking));
    parkingUpdatedAt.set(parking.id, updatedAt);
    changed++;
  }

  const evicted = enforceMemoryLimit();
  return { added, changed, evicted };
}

function restoreCacheEntries(entries: ParkingCacheEntry[]): { restored: number; evicted: number } {
  let restored = 0;
  for (const entry of entries) {
    const existing = allParkings.get(entry.parking.id);
    const existingUpdatedAt = parkingUpdatedAt.get(entry.parking.id) ?? 0;
    if (existing && existingUpdatedAt >= entry.updatedAt) continue;
    allParkings.set(entry.parking.id, mergeParking(existing, entry.parking));
    parkingUpdatedAt.set(entry.parking.id, entry.updatedAt);
    restored++;
  }
  return { restored, evicted: enforceMemoryLimit() };
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
    const entries: ParkingCacheEntry[] = Array.from(allParkings.values()).map((parking) => ({
      parking,
      updatedAt: parkingUpdatedAt.get(parking.id) ?? Date.now(),
    }));
    const encoded = encodeParkingCache({ entries, coverage: [...fetchedCoverage] });
    AsyncStorage.setItem(
      STORAGE_KEY,
      encoded,
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
  const [zoneGeometryLoading, setZoneGeometryLoading] = useState(false);
  // Surfaces a fetch failure to the UI. Previously a failed/rate-limited
  // region fetch only logged a console.warn — "Search this area" would just
  // go quiet with no new markers and no feedback, indistinguishable from "we
  // searched and there's genuinely nothing here".
  const [fetchError, setFetchError] = useState<string | null>(null);

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
    const generation = cacheGeneration;

    AsyncStorage.getItem(STORAGE_KEY)
      .then(raw => {
        if (generation !== cacheGeneration) return;
        const decoded = decodeParkingCache(raw);
        const { restored, evicted } = restoreCacheEntries(decoded.snapshot.entries);
        fetchedCoverage.splice(
          0,
          fetchedCoverage.length,
          ...compactCoverage([
            ...fetchedCoverage,
            ...(evicted === 0 ? decoded.snapshot.coverage : []),
          ]),
        );
        if (restored > 0) {
          // Defer the initial render of persisted markers until after any
          // in-progress gesture so the first map interaction never hiccups.
          InteractionManager.runAfterInteractions(() => {
            if (generation === cacheGeneration) {
              setParkings(Array.from(allParkings.values()));
            }
          });
          console.log(`[useMapParkings] hydrated ${restored} spots from AsyncStorage`);
        }

        if (decoded.corrupt || decoded.needsRewrite) {
          const entries: ParkingCacheEntry[] = Array.from(allParkings.values()).map((parking) => ({
            parking,
            updatedAt: parkingUpdatedAt.get(parking.id) ?? Date.now(),
          }));
          return AsyncStorage.setItem(
            STORAGE_KEY,
            encodeParkingCache({ entries, coverage: [...fetchedCoverage] }),
          );
        }
      })
      .catch(err => console.warn('[useMapParkings] storage read:', err));
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Cache-clear reset registration ─────────────────────────────────────────
  // When the persistent parking cache is cleared, also drop the in-memory
  // session caches and empty the rendered set — leaving the map in a clean,
  // valid state. Navigation state lives elsewhere and is untouched.
  useEffect(() => {
    const unregister = registerParkingCacheReset(() => {
      if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
      cacheGeneration++;
      if (geometryTimer.current) clearTimeout(geometryTimer.current);
      abortCtrl.current?.abort();
      geometryAbortCtrl.current?.abort();
      geometryRequested.current.clear();
      allParkings.clear();
      parkingUpdatedAt.clear();
      fetchedCoverage.length = 0;
      storageLoaded = false;
      setParkings([]);
      setLoading(false);
      setZoneGeometryLoading(false);
      setFetchError(null);
    });
    return unregister;
  }, []);

  // ── Region fetch ──────────────────────────────────────────────────────────
  useEffect(() => () => {
    if (geometryTimer.current) clearTimeout(geometryTimer.current);
    abortCtrl.current?.abort();
    geometryAbortCtrl.current?.abort();
  }, []);

  // Runs synchronously up through the guard checks and flips `loading` on the
  // SAME tick as the call — previously the entire function body (including
  // setLoading(true)) sat behind a 500 ms debounce, so the "Search this area"
  // button visibly did nothing for half a second after every tap. That delay
  // was carried over from an earlier pan-triggered auto-fetch design; this is
  // now the ONLY caller (a single explicit button press — see
  // MapScreen.handleSearchParking), and its own `disabled={loading}` already
  // prevents a rapid double-tap from firing a second request, so nothing here
  // still needs debouncing.
  const loadForRegion = useCallback((region: Region) => {
    // ── 1. Zoom guard ──────────────────────────────────────────────────────
    if (deltaToZoom(region.latitudeDelta) < MIN_ZOOM) {
      console.log(
        `[useMapParkings] zoom ${deltaToZoom(region.latitudeDelta)} < ${MIN_ZOOM} — skipping`,
      );
      return;
    }

    // ── 2. Cooldown guard ──────────────────────────────────────────────────
    if (Date.now() < cooldownUntil.current) return;

    const newBox = regionToBBox(region);

    // ── 3. Containment check (fast path) ───────────────────────────────────
    if (isExactlyContainedInAny(newBox, fetchedCoverage)) {
      console.log('[useMapParkings] viewport fully contained in session cache — skipping');
      return;
    }

    // ── 4. Exact-union coverage check ───────────────────────────────────────
    // Small overlaps must not hide most of a newly searched viewport.
    const fraction = exactCoveredFraction(newBox, fetchedCoverage);
    if (fraction >= COVERAGE_THRESHOLD) {
      console.log(
        `[useMapParkings] ${(fraction * 100).toFixed(0)}% of viewport in session cache — skipping`,
      );
      return;
    }

    // ── 5. Cancel any in-flight request ─────────────────────────────────────
    abortCtrl.current?.abort();
    const ctrl = new AbortController();
    abortCtrl.current = ctrl;
    const generation = cacheGeneration;

    // ── 6. Fetch ─────────────────────────────────────────────────────────────
    const { south, west, north, east } = newBox;
    console.log(
      `[useMapParkings] fetching (${(fraction * 100).toFixed(0)}% cached) ` +
      `S=${south.toFixed(4)} W=${west.toFixed(4)} N=${north.toFixed(4)} E=${east.toFixed(4)}`,
    );

    setLoading(true);
    setFetchError(null);
    (async () => {
      try {
        // Sourced through the ParkingDataProvider seam (Overpass today, a cached
        // backend tomorrow) — see services/parking/parkingDataProvider.ts.
        const data = await defaultParkingDataProvider.loadViewport(
          { south, west, north, east }, ctrl.signal,
        );
        if (ctrl.signal.aborted || generation !== cacheGeneration) return;

        const validated = validateParkingArray(data as unknown);
        if (!validated.validContainer || validated.dropped > 0) {
          throw new Error('Parking provider returned invalid data');
        }
        console.log(`[useMapParkings] received ${validated.items.length} elements from API`);

        const merged = mergeIntoCache(validated.items);
        console.log(
          `[useMapParkings] +${merged.added} new, ${merged.changed} refreshed` +
          `  |  ${allParkings.size} total in session cache`,
        );

        // Fresh provider objects replace stale tags/positions while retaining
        // geometry loaded separately for the same OSM id.
        if (merged.evicted === 0) {
          fetchedCoverage.splice(
            0,
            fetchedCoverage.length,
            ...compactCoverage([
              ...fetchedCoverage,
              { bounds: newBox, fetchedAt: Date.now() },
            ]),
          );
        }

        if (merged.changed > 0) {
          setParkings(Array.from(allParkings.values()));
        }
        persistCache();

      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') return;
        if (ctrl.signal.aborted || generation !== cacheGeneration) return;

        if (err instanceof Error && err.message.includes('HTTP 429')) {
          cooldownUntil.current = Date.now() + COOLDOWN_MS;
          console.warn('[useMapParkings] 429 rate-limited — pausing 5 s');
          setFetchError('Parking data server is busy — try again in a few seconds.');
        } else {
          console.warn('[useMapParkings] fetch error:', err);
          setFetchError('Could not load parking data. Check your connection and try again.');
        }

      } finally {
        if (abortCtrl.current === ctrl) setLoading(false);
      }
    })();
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
      const generation = cacheGeneration;
      setZoneGeometryLoading(true);

      try {
        const results = await fetchParkingGeometryBatch(pending, ctrl.signal);
        if (ctrl.signal.aborted || generation !== cacheGeneration) return;
        if (results.size === 0) {
          pending.forEach(id => geometryRequested.current.delete(id));
          return;
        }

        let changed = false;
        for (const [id, geom] of results) {
          const existing = allParkings.get(id);
          if (existing && (geom.polygon || geom.polyline)) {
            const normalized = normalizeGeometryForParkingTags(
              existing.tags,
              geom.polygon,
              geom.polyline,
            );
            allParkings.set(id, { ...existing, ...normalized });
            parkingUpdatedAt.set(id, Date.now());
            changed = true;
          } else {
            geometryRequested.current.delete(id);
          }
        }
        pending.forEach((id) => {
          if (!results.has(id)) geometryRequested.current.delete(id);
        });
        if (changed) {
          setParkings(Array.from(allParkings.values()));
          persistCache();
        }
      } catch (err: unknown) {
        if (err instanceof Error && err.name === 'AbortError') {
          pending.forEach(id => geometryRequested.current.delete(id));
          return;
        }
        // Zone geometry is an optional enhancement (outline polygons). When the
        // geo mirrors are unreachable the markers still work — so fail quietly
        // and let the requested ids retry on a later pass, no error spam.
        pending.forEach(id => geometryRequested.current.delete(id));
      } finally {
        if (geometryAbortCtrl.current === ctrl) setZoneGeometryLoading(false);
      }
    }, GEOMETRY_DEBOUNCE_MS);
  }, []);

  return { parkings, loading, zoneGeometryLoading, fetchError, loadForRegion, loadZoneGeometry };
};
