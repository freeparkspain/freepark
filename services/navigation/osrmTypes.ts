// ─── Raw OSRM JSON response types ─────────────────────────────────────────────
// These mirror the wire format of the OSRM `route` service ONLY. They must not
// leak past the mapper (osrmMapper.ts). Domain code uses types/navigation.ts.
//
// Endpoint shape:
//   /route/v1/driving/{lon},{lat};{lon},{lat}
//     ?overview=full&geometries=polyline6&steps=true&alternatives=3

export interface OsrmManeuver {
  type:      string;
  modifier?: string;
  /** [longitude, latitude] — OSRM's coordinate order. */
  location:  [number, number];
  /** Roundabout/rotary exit number, when applicable. */
  exit?:     number;
  bearing_before?: number;
  bearing_after?:  number;
}

export interface OsrmStep {
  /** polyline6-encoded geometry of just this step. */
  geometry?: string;
  maneuver:  OsrmManeuver;
  /** Length of the step in metres. */
  distance:  number;
  /** Duration of the step in seconds. */
  duration:  number;
  /** Street name (may be empty string). */
  name?:     string;
  ref?:      string;
  /** Transport mode for this step — "driving" normally, "ferry" when the
   *  route crosses water on a car ferry (OSRM's driving profile allows
   *  routing over `route=ferry` ways tagged as vehicle-accessible). */
  mode?:     string;
}

export interface OsrmLeg {
  steps?:    OsrmStep[];
  distance:  number;
  duration:  number;
  summary?:  string;
}

export interface OsrmRoute {
  /** polyline6-encoded full route geometry (overview=full). */
  geometry:  string;
  legs:      OsrmLeg[];
  distance:  number;
  duration:  number;
}

export interface OsrmRouteResponse {
  code:      string;
  message?:  string;
  routes?:   OsrmRoute[];
}
