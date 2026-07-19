import {
  isValidCoordinate,
  isValidBounds,
  isUsablePreparedNavigationRoute,
  sanitizeRouteCoordinates,
  validateRouteGeometry,
} from '../navigation/services/routeValidator';

describe('isValidCoordinate', () => {
  it('accepts finite in-range coordinates', () => {
    expect(isValidCoordinate({ latitude: 36.7, longitude: -4.4 })).toBe(true);
  });
  it('rejects NaN / Infinity / out-of-range / null / non-objects', () => {
    expect(isValidCoordinate({ latitude: NaN, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: Infinity, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 91, longitude: 0 })).toBe(false);
    expect(isValidCoordinate({ latitude: 0, longitude: 181 })).toBe(false);
    expect(isValidCoordinate(null)).toBe(false);
    expect(isValidCoordinate('nope')).toBe(false);
    expect(isValidCoordinate({ latitude: 0 })).toBe(false);
  });
});

describe('sanitizeRouteCoordinates', () => {
  it('drops invalid points and consecutive duplicates', () => {
    const input = [
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0 },        // duplicate
      { latitude: NaN, longitude: 0 },       // invalid
      { latitude: 40, longitude: 0.001 },
      { latitude: 999, longitude: 0 },       // out of range
    ];
    const out = sanitizeRouteCoordinates(input);
    expect(out).toEqual([
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0.001 },
    ]);
  });
  it('returns [] for non-arrays', () => {
    expect(sanitizeRouteCoordinates(undefined)).toEqual([]);
    expect(sanitizeRouteCoordinates({} as unknown)).toEqual([]);
  });
});

describe('sanitizeRouteCoordinates — route normalization invariants (Bug 1)', () => {
  it('preserves route ORDER (never sorts geographically)', () => {
    // Deliberately not in geographic order — a real route can go east then west.
    const route = [
      { latitude: 40, longitude: 0.005 },
      { latitude: 40, longitude: 0.001 },
      { latitude: 40, longitude: 0.009 },
    ];
    expect(sanitizeRouteCoordinates(route)).toEqual(route);
  });

  it('keeps legitimate tight turns / switchbacks (close but distinct points)', () => {
    const hairpin = [
      { latitude: 40.0000, longitude: 0.0000 },
      { latitude: 40.0002, longitude: 0.0000 },
      { latitude: 40.0002, longitude: 0.00005 }, // near, but a real turn vertex
      { latitude: 40.0000, longitude: 0.00005 },
    ];
    expect(sanitizeRouteCoordinates(hairpin)).toHaveLength(4);
  });

  it('removes only EXACT consecutive duplicates, not a returning path', () => {
    const out = sanitizeRouteCoordinates([
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0 }, // exact dup → dropped
      { latitude: 41, longitude: 1 },
      { latitude: 40, longitude: 0 }, // same as start but NOT consecutive → kept
    ]);
    expect(out).toEqual([
      { latitude: 40, longitude: 0 },
      { latitude: 41, longitude: 1 },
      { latitude: 40, longitude: 0 },
    ]);
  });
});

describe('validateRouteGeometry', () => {
  it('accepts a valid multi-point route', () => {
    const res = validateRouteGeometry([
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0.01 },
    ]);
    expect(res.ok).toBe(true);
    expect(res.coordinates).toHaveLength(2);
  });
  it('rejects an empty route with an English reason', () => {
    const res = validateRouteGeometry([]);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe('The route data is invalid.');
  });
  it('rejects a single-point / zero-length route', () => {
    expect(validateRouteGeometry([{ latitude: 40, longitude: 0 }]).ok).toBe(false);
    // Two identical points collapse to one after sanitize → invalid.
    expect(validateRouteGeometry([
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0 },
    ]).ok).toBe(false);
  });
});

describe('isUsablePreparedNavigationRoute', () => {
  const route = {
    points: [
      { latitude: 40, longitude: 0 },
      { latitude: 40, longitude: 0.01 },
    ],
    steps: [{
      instruction: 'Continue',
      maneuverLocation: { latitude: 40, longitude: 0 },
      distanceMeters: 850,
      durationSeconds: 90,
      maneuverType: 'continue',
      maneuverModifier: null,
      streetName: null,
      exit: null,
    }],
    totalDistanceMeters: 850,
    totalDurationSeconds: 90,
  };

  it('accepts a complete preview route and rejects incomplete data', () => {
    expect(isUsablePreparedNavigationRoute(route)).toBe(true);
    expect(isUsablePreparedNavigationRoute({ ...route, points: [route.points[0]] })).toBe(false);
    expect(isUsablePreparedNavigationRoute({ ...route, steps: [] })).toBe(false);
    expect(isUsablePreparedNavigationRoute({ ...route, totalDurationSeconds: NaN })).toBe(false);
  });
});

describe('isValidBounds', () => {
  it('accepts a well-ordered box and rejects degenerate/NaN boxes', () => {
    expect(isValidBounds({ latitude: 40, longitude: 0 }, { latitude: 41, longitude: 1 })).toBe(true);
    expect(isValidBounds({ latitude: 41, longitude: 0 }, { latitude: 40, longitude: 1 })).toBe(false);
    expect(isValidBounds({ latitude: NaN, longitude: 0 }, { latitude: 41, longitude: 1 })).toBe(false);
  });
});
