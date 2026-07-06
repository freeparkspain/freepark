import { useMemo } from 'react';
import { LatLng } from '../types/parking';
import { MatchedLocation } from '../types/navigation';
import { splitRouteByProgress, RouteSplit } from '../navigation/services/routeProgress';

// ─── useRouteProgress ─────────────────────────────────────────────────────────
// Derives the completed/remaining split from the route + the arrow's matched
// position. Pure-memoized: recomputes only when the route or the matched
// location changes (~1 Hz), never per animation frame, and returns stable array
// identities so NavigationRoute's memo can skip re-rendering.

export function useRouteProgress(
  routeCoordinates: LatLng[],
  matched: MatchedLocation | null,
): RouteSplit {
  return useMemo(
    () =>
      splitRouteByProgress(
        routeCoordinates,
        matched
          ? { segmentIndex: matched.routeSegmentIndex, position: matched.matchedPosition }
          : null,
      ),
    [routeCoordinates, matched],
  );
}
