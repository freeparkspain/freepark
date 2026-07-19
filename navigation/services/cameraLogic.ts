import {
  MapEdgePadding,
  MapViewportLayout,
  NavigationCameraMode,
} from '../../types/navigation';
import { normalizeBearing } from './bearing';

// ─── Navigation camera logic (pure) ───────────────────────────────────────────

export interface RecenterBearingInputs {
  gpsBearing:           number | null;
  speedMps:             number | null;
  matchedSegmentBearing: number | null;
  firstSegmentBearing:  number | null;
  mapBearing:           number | null;
  minReliableSpeedMps:  number;
}

/**
 * Resolve the heading to use when recentering, per the documented fallback
 * chain: reliable GPS heading → matched segment → first route segment → current
 * map bearing → north. Guarantees a sensible orientation even right after the
 * route is built and before the car has moved.
 */
export function resolveRecenterBearing(i: RecenterBearingInputs): number {
  const movingReliably =
    i.speedMps != null && i.speedMps >= i.minReliableSpeedMps && i.gpsBearing != null;
  if (movingReliably) return normalizeBearing(i.gpsBearing!);
  if (i.matchedSegmentBearing != null) return normalizeBearing(i.matchedSegmentBearing);
  if (i.firstSegmentBearing != null) return normalizeBearing(i.firstSegmentBearing);
  if (i.mapBearing != null) return normalizeBearing(i.mapBearing);
  return 0;
}

/**
 * Map edge padding that (a) reserves space for the top instruction card and the
 * bottom trip bar (respecting safe-area insets) and (b) biases the camera target
 * DOWNWARD so the car sits at ~`ratio` of the usable height, leaving more road
 * visible ahead.
 *
 * Google Maps centres the camera target in the region minus padding, so a larger
 * TOP padding pushes the target lower on screen. Derivation:
 *   targetY = padTop + (H - padTop - padBottom)/2  ==  ratio · H
 *   ⇒ padTop − padBottom = (2·ratio − 1)·H
 * padTop is clamped so it never collapses the viewport or ignores the top card.
 */
export function computeMapPadding(layout: MapViewportLayout, ratio: number): MapEdgePadding {
  const { height, topOverlayHeight, bottomOverlayHeight, safeAreaTop, safeAreaBottom } = layout;
  const padBottom = safeAreaBottom + bottomOverlayHeight;
  const minTop = safeAreaTop + topOverlayHeight;

  const desiredTop = (2 * ratio - 1) * height + padBottom;
  const maxTop = height * 0.6; // never collapse the visible strip
  const padTop = Math.min(maxTop, Math.max(minTop, desiredTop));

  return { top: padTop, bottom: padBottom, left: 0, right: 0 };
}

/**
 * Comfortable driving zoom, adapted to speed so the driver always sees enough
 * road ahead: city speed keeps the base zoom; faster travel zooms out so more
 * of the route ahead is visible (like professional nav apps).
 */
export function drivingZoom(
  speedMps: number | null,
  baseZoom: number,
  distanceToNextManeuverMeters: number | null = null,
): number {
  const speed = Math.max(0, speedMps ?? 0);
  let zoomOut = 0;
  if (speed > 16) {
    zoomOut = 1.2 + Math.min(0.8, ((speed - 16) / 14) * 0.8);
  } else if (speed > 9) {
    zoomOut = 0.5 + ((speed - 9) / 7) * 0.7;
  } else if (speed > 4) {
    zoomOut = ((speed - 4) / 5) * 0.5;
  }

  const maneuverDistance = distanceToNextManeuverMeters ?? Number.POSITIVE_INFINITY;
  const approachZoom = maneuverDistance < 150
    ? 0.5 * (1 - Math.max(0, maneuverDistance) / 150)
    : 0;
  return Math.min(baseZoom + 0.5, baseZoom - zoomOut + approachZoom);
}

/** Default padding for normal (non-following) map use. */
export function defaultMapPadding(layout: MapViewportLayout): MapEdgePadding {
  return {
    top:    layout.safeAreaTop + layout.topOverlayHeight,
    bottom: layout.safeAreaBottom + layout.bottomOverlayHeight,
    left:   0,
    right:  0,
  };
}

/**
 * Whether a camera region change should flip us into free mode: only when we're
 * following and Google Maps explicitly reports a user gesture.
 */
export function shouldEnterFreeMode(
  isGesture: boolean | undefined,
  mode: NavigationCameraMode,
): boolean {
  return mode === 'following' && isGesture === true;
}

/** One start-focus per explicit navigation session, once route and car exist. */
export function shouldFocusNavigationSession(
  navigationActive: boolean,
  routePointCount: number,
  hasCarPosition: boolean,
  sessionRevision: number,
  focusedSessionRevision: number | null,
): boolean {
  return navigationActive &&
    routePointCount >= 2 &&
    hasCarPosition &&
    focusedSessionRevision !== sessionRevision;
}
