import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  CacheClearResult,
  KeyValueStore,
  clearCacheKeys,
  readJsonArraySafe,
} from './keyValueStore';

// ─── Parking cache (AsyncStorage-backed) ──────────────────────────────────────
// The concrete persistence wiring for parking data. Imports AsyncStorage, so it
// is only used from app code (the pure logic in keyValueStore.ts is what tests
// exercise). Bump the key suffix when the OsmParking shape changes.

export const PARKING_STORAGE_KEY = 'freepark_v1_parkings';

const asyncKeyValueStore: KeyValueStore = {
  getItem:    (k) => AsyncStorage.getItem(k),
  setItem:    (k, v) => AsyncStorage.setItem(k, v),
  removeItem: (k) => AsyncStorage.removeItem(k),
};

// In-memory caches (the module-level Maps/flags in useMapParkings) register a
// reset here so a persistent-cache clear also drops the live session state and
// the app lands in a clean, valid empty state — without tearing down the map or
// navigation. Registration is lifecycle-scoped (unregister on unmount).
const resetters = new Set<() => void>();

export function registerParkingCacheReset(fn: () => void): () => void {
  resetters.add(fn);
  return () => { resetters.delete(fn); };
}

/**
 * Clear the persisted parking cache AND reset in-memory session caches.
 * Idempotent, concurrency-safe, never throws (see clearCacheKeys). Does NOT
 * touch navigation state or configuration — only parking cache data.
 */
export function clearParkingCache(): Promise<CacheClearResult> {
  return clearCacheKeys(asyncKeyValueStore, [PARKING_STORAGE_KEY], () => {
    resetters.forEach((fn) => {
      try { fn(); } catch { /* one bad resetter must not block the others */ }
    });
  });
}

/** Safe read of the persisted parking array (corruption-tolerant). */
export function readParkingCache<T>(): Promise<T[]> {
  return readJsonArraySafe<T>(asyncKeyValueStore, PARKING_STORAGE_KEY);
}

/** Persist the parking array. */
export function writeParkingCache(value: unknown): Promise<void> {
  return AsyncStorage.setItem(PARKING_STORAGE_KEY, JSON.stringify(value));
}
