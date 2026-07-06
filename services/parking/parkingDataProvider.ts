import { BBox, OsmParking } from '../../types/parking';
import { fetchParkingData } from '../overpassService';

// ─── ParkingDataProvider ──────────────────────────────────────────────────────
// Isolates the parking data SOURCE behind an interface, so the app depends on a
// seam rather than on Overpass directly. Today it's backed by the public
// Overpass mirrors (development/testing); a future cached backend or vector-tile
// service can drop in as another implementation without touching the hook/UI.
//
//   OverpassParkingDataProvider   → current (public Overpass, viewport bbox)
//   BackendParkingDataProvider    → future  (GET /api/parking?west&south&east&north&zoom)
//
// See README for the production migration plan.

export interface ParkingDataProvider {
  /** Load parking for a viewport bounding box. Honours an AbortSignal. */
  loadViewport(bounds: BBox, signal?: AbortSignal): Promise<OsmParking[]>;
}

export class OverpassParkingDataProvider implements ParkingDataProvider {
  loadViewport(bounds: BBox, signal?: AbortSignal): Promise<OsmParking[]> {
    const { south, west, north, east } = bounds;
    return fetchParkingData(south, west, north, east, signal);
  }
}

/** The default provider used by the app (swap here to point at a backend). */
export const defaultParkingDataProvider: ParkingDataProvider = new OverpassParkingDataProvider();
