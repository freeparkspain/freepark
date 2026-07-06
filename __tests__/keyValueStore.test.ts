import {
  KeyValueStore,
  clearCacheKeys,
  isClearInFlight,
  readJsonArraySafe,
} from '../services/cache/keyValueStore';

// In-memory fake store for deterministic, native-free testing.
class FakeStore implements KeyValueStore {
  map = new Map<string, string>();
  removeCalls = 0;
  async getItem(key: string) { return this.map.has(key) ? this.map.get(key)! : null; }
  async setItem(key: string, value: string) { this.map.set(key, value); }
  async removeItem(key: string) { this.removeCalls++; this.map.delete(key); }
}

// A store whose removeItem always rejects (simulates a locked/missing backend).
class FailingRemoveStore extends FakeStore {
  async removeItem(): Promise<void> { throw new Error('backend unavailable'); }
}

const KEY = 'freepark_v1_parkings';

describe('clearCacheKeys', () => {
  it('clears a populated cache and runs onCleared', async () => {
    const store = new FakeStore();
    store.map.set(KEY, '[1,2,3]');
    let resetRan = false;
    const res = await clearCacheKeys(store, [KEY], () => { resetRan = true; });
    expect(res.ok).toBe(true);
    expect(store.map.has(KEY)).toBe(false);
    expect(resetRan).toBe(true);
  });

  it('is safe (idempotent) on an empty cache', async () => {
    const store = new FakeStore();
    const res = await clearCacheKeys(store, [KEY]);
    expect(res.ok).toBe(true);
  });

  it('can be called twice without throwing', async () => {
    const store = new FakeStore();
    store.map.set(KEY, '[1]');
    const a = await clearCacheKeys(store, [KEY]);
    const b = await clearCacheKeys(store, [KEY]);
    expect(a.ok).toBe(true);
    expect(b.ok).toBe(true);
  });

  it('coalesces concurrent clears into one in-flight operation', async () => {
    const store = new FakeStore();
    store.map.set(KEY, '[1]');
    const p1 = clearCacheKeys(store, [KEY]);
    const p2 = clearCacheKeys(store, [KEY]);
    expect(p1).toBe(p2);            // same in-flight promise
    expect(isClearInFlight()).toBe(true);
    await Promise.all([p1, p2]);
    expect(isClearInFlight()).toBe(false);
    expect(store.removeCalls).toBe(1); // only one actual removal
  });

  it('never throws when the backend removal fails (missing/locked files)', async () => {
    const store = new FailingRemoveStore();
    const res = await clearCacheKeys(store, [KEY]);
    expect(res.ok).toBe(true); // per-key failure is swallowed
  });
});

describe('readJsonArraySafe', () => {
  it('returns the parsed array for valid JSON', async () => {
    const store = new FakeStore();
    store.map.set(KEY, JSON.stringify([{ a: 1 }, { a: 2 }]));
    const res = await readJsonArraySafe<{ a: number }>(store, KEY);
    expect(res).toHaveLength(2);
  });

  it('returns [] for corrupted metadata and drops the bad entry', async () => {
    const store = new FakeStore();
    store.map.set(KEY, '{ this is not json');
    const res = await readJsonArraySafe(store, KEY);
    expect(res).toEqual([]);
    expect(store.map.has(KEY)).toBe(false); // corrupted entry removed
  });

  it('returns [] for a non-array payload', async () => {
    const store = new FakeStore();
    store.map.set(KEY, JSON.stringify({ not: 'an array' }));
    expect(await readJsonArraySafe(store, KEY)).toEqual([]);
  });

  it('returns [] when the key is missing', async () => {
    expect(await readJsonArraySafe(new FakeStore(), KEY)).toEqual([]);
  });
});
