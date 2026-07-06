// ─── Key-value cache primitives (pure, framework-free) ────────────────────────
// The clearing/reading logic lives here, decoupled from AsyncStorage, so it can
// be unit-tested with a fake store and reused for any keyed cache. No RN/Expo
// imports — safe to import from tests.

export interface KeyValueStore {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

export interface CacheClearResult {
  ok: boolean;
  /** User-facing English message when ok === false. */
  error?: string;
}

// Single in-flight clear shared across callers so rapid double-taps (or a clear
// firing from two places at once) collapse into ONE operation instead of racing.
let clearInFlight: Promise<CacheClearResult> | null = null;

/**
 * Idempotent, concurrency-safe clear of the given keys.
 * - Safe when the cache is already empty or keys are missing (removeItem is a
 *   no-op and per-key failures are swallowed so one bad key can't abort the rest).
 * - Concurrent calls share the same in-flight promise (no interleaving).
 * - Never throws; returns a result with an English error message on failure.
 * - `onCleared` runs only after storage is cleared (e.g. reset in-memory caches).
 */
export function clearCacheKeys(
  store: KeyValueStore,
  keys: string[],
  onCleared?: () => void,
): Promise<CacheClearResult> {
  if (clearInFlight) return clearInFlight;

  clearInFlight = (async (): Promise<CacheClearResult> => {
    try {
      await Promise.all(
        keys.map((k) => store.removeItem(k).catch(() => { /* missing/locked key — ignore */ })),
      );
      try {
        onCleared?.();
      } catch {
        /* in-memory reset must never surface as a clear failure */
      }
      return { ok: true };
    } catch {
      return { ok: false, error: 'Could not clear cached data. Please try again.' };
    } finally {
      clearInFlight = null;
    }
  })();

  return clearInFlight;
}

/** True while a clear is in progress (exposed for tests / UI busy state). */
export function isClearInFlight(): boolean {
  return clearInFlight !== null;
}

/**
 * Read a JSON array from the store, tolerating corruption: invalid JSON or a
 * non-array payload yields [] and the bad entry is dropped so it can't crash
 * subsequent reads. Never throws.
 */
export async function readJsonArraySafe<T>(
  store: KeyValueStore,
  key: string,
): Promise<T[]> {
  let raw: string | null;
  try {
    raw = await store.getItem(key);
  } catch {
    return [];
  }
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : dropAndEmpty(store, key);
  } catch {
    return dropAndEmpty(store, key);
  }
}

function dropAndEmpty<T>(store: KeyValueStore, key: string): T[] {
  // Fire-and-forget cleanup of a corrupted entry.
  void store.removeItem(key).catch(() => { /* ignore */ });
  return [];
}
