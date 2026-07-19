// ─── Parking Level-of-Detail (LOD) thresholds ─────────────────────────────────
// Single source of truth for how much parking-zone detail the map renders at a
// given zoom. Three levels keep the map light when the user is looking at a
// large area and progressively reveal geometry as they zoom in:
//
//   low    — markers/clusters only, NO zone geometry (large visible area)
//   medium — SIMPLIFIED zone outlines only (no markers/clusters)
//   high   — FULL zone outlines only (no markers/clusters)
//
// Thresholds live here (not scattered across components) so the map, the
// geometry-fetch effect and the rendering layer all agree on one definition.

export type ParkingLod = 'low' | 'medium' | 'high';

/**
 * Explicit rendering contract for every LOD. Keeping this pure and centralised
 * prevents markers and zone geometry from accidentally being mounted together.
 */
export interface ParkingLodPresentation {
  showMarkers: boolean;
  showZones: boolean;
  simplifyZones: boolean;
}

export const PARKING_LOD_PRESENTATION: Record<ParkingLod, ParkingLodPresentation> = {
  low: {
    showMarkers: true,
    showZones: false,
    simplifyZones: false,
  },
  medium: {
    showMarkers: false,
    showZones: true,
    simplifyZones: true,
  },
  high: {
    showMarkers: false,
    showZones: true,
    simplifyZones: false,
  },
};

// Approximate Web-Mercator zoom from a MapView latitudeDelta. Fractional (unlike
// utils/geo.deltaToZoom, which rounds) so the hysteresis band below is smooth.
export const zoomFromDelta = (latitudeDelta: number): number => {
  if (!(latitudeDelta > 0)) return 14; // guard against 0 / NaN during animations
  return Math.log2(360 / latitudeDelta);
};

// Zoom at/above which each level begins. Chosen so the default city view
// (~zoom 12) is "low" (clean clustered markers) and street-level browsing
// reveals medium → full outlines as the user zooms in.
export const LOD_MEDIUM_MIN_ZOOM = 14; // >= → at least medium (simplified outlines)
export const LOD_HIGH_MIN_ZOOM   = 16; // >= → full geometry

// Hysteresis margin (in zoom units). A zoom hovering exactly on a boundary must
// not flip the level every settle, so crossing UP a level requires threshold+H
// and dropping DOWN requires threshold−H — a small dead-band that kills flicker.
export const LOD_HYSTERESIS = 0.4;

/**
 * Resolve the LOD for a viewport, honouring the previous level so a zoom sitting
 * on a threshold doesn't oscillate. Pure — safe to unit-test.
 */
export const getParkingLod = (
  latitudeDelta: number,
  previous: ParkingLod = 'low',
): ParkingLod => {
  const z = zoomFromDelta(latitudeDelta);
  const H = LOD_HYSTERESIS;
  const medUp   = LOD_MEDIUM_MIN_ZOOM + H;
  const medDown = LOD_MEDIUM_MIN_ZOOM - H;
  const hiUp    = LOD_HIGH_MIN_ZOOM + H;
  const hiDown  = LOD_HIGH_MIN_ZOOM - H;

  switch (previous) {
    case 'high':
      if (z < hiDown) return z < medDown ? 'low' : 'medium';
      return 'high';
    case 'medium':
      if (z >= hiUp)   return 'high';
      if (z <  medDown) return 'low';
      return 'medium';
    case 'low':
    default:
      if (z >= hiUp)  return 'high';
      if (z >= medUp) return 'medium';
      return 'low';
  }
};

// Tolerance (metres) for medium-zoom outline simplification — see
// utils/parkingGeometry.simplifiedZoneGeometry. Coarse enough to cut vertex
// counts hard, fine enough that a bay outline still reads correctly.
export const ZONE_SIMPLIFY_TOLERANCE_M = 6;
