import { useState, useRef, useCallback } from 'react';
import { OsmParking } from '../types/parking';
import { fetchParkingGeometry, GeometryResult } from '../services/overpassService';

export type { GeometryResult };

// Module-level cache — survives re-mounts; same parking never fetched twice
const geometryCache = new Map<string, GeometryResult>();

export const useGeometryLoader = () => {
  const [geometry,        setGeometry]        = useState<GeometryResult | null>(null);
  const [geometryLoading, setGeometryLoading] = useState(false);
  const abortCtrl = useRef<AbortController | null>(null);

  const loadGeometry = useCallback(async (parking: OsmParking) => {
    // Abort ANY previous in-flight request upfront — before node/cache
    // shortcuts — so a cached-path return can't be overtaken by the old
    // request landing and overwriting the freshly-set geometry.
    // Nulling abortCtrl prevents the aborted request's finally block from
    // toggling loading state on the new selection.
    abortCtrl.current?.abort();
    abortCtrl.current = null;

    setGeometry(null);
    setGeometryLoading(false);

    if (parking.id.startsWith('n')) return;

    const cached = geometryCache.get(parking.id);
    if (cached) {
      setGeometry(cached);
      return;
    }

    const ctrl = new AbortController();
    abortCtrl.current = ctrl;

    setGeometryLoading(true);
    try {
      const result = await fetchParkingGeometry(parking.id, ctrl.signal);
      geometryCache.set(parking.id, result);
      if (abortCtrl.current === ctrl) setGeometry(result);
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return;
      console.warn('[useGeometryLoader]', err);
    } finally {
      if (abortCtrl.current === ctrl) setGeometryLoading(false);
    }
  }, []);

  // Call when the bottom sheet closes — cancels any pending fetch and clears
  // the rendered overlay so the map returns to a clean state
  const clearGeometry = useCallback(() => {
    abortCtrl.current?.abort();
    setGeometry(null);
    setGeometryLoading(false);
  }, []);

  return { geometry, geometryLoading, loadGeometry, clearGeometry };
};
