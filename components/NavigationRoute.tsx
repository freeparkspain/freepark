import React, { memo } from 'react';
import { Polyline } from 'react-native-maps';
import { LatLng } from '../types/parking';
import { NAV_ROUTE_STYLE as S, NAV_ROUTE_Z as Z } from '../constants/navigationTheme';

interface Props {
  /** The FULL route polyline — a stable array for the whole navigation session. */
  route: LatLng[];
  /** The already-travelled portion, drawn muted on top of the base ribbon. */
  completed: LatLng[];
}

// Premium layered route.
//
// The base ribbon (casing → accent → highlight) is drawn from the FULL route,
// whose array identity is stable for the entire session. This is the fix for
// "the route disappears when I zoom": previously the line was drawn from the
// per-GPS-tick "remaining" slice, so its identity changed ~1 Hz and react-native
// -maps re-mounted the polylines — which Google Maps can drop mid-zoom-gesture.
// A stable base never re-mounts, so it stays put through any camera movement.
//
// Progress is shown by drawing the COMPLETED portion muted on top (higher
// zIndex); only that short overlay changes as the driver advances.
function NavigationRouteBase({ route, completed }: Props) {
  if (route.length < 2) return null;
  const hasCompleted = completed.length >= 2;

  return (
    <>
      <Polyline
        coordinates={route}
        strokeWidth={S.casingWidth}
        strokeColor={S.casingColor}
        lineCap="round"
        lineJoin="round"
        zIndex={Z.casing}
      />
      <Polyline
        coordinates={route}
        strokeWidth={S.mainWidth}
        strokeColor={S.mainColor}
        lineCap="round"
        lineJoin="round"
        zIndex={Z.main}
      />
      <Polyline
        coordinates={route}
        strokeWidth={S.highlightWidth}
        strokeColor={S.highlightColor}
        lineCap="round"
        lineJoin="round"
        zIndex={Z.highlight}
      />
      {hasCompleted && (
        <Polyline
          coordinates={completed}
          strokeWidth={S.completedWidth}
          strokeColor={S.completedColor}
          lineCap="round"
          lineJoin="round"
          zIndex={Z.completed}
        />
      )}
    </>
  );
}

export const NavigationRoute = memo(
  NavigationRouteBase,
  (prev, next) => prev.route === next.route && prev.completed === next.completed,
);
