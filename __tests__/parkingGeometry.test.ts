import {
  buildStreetParkingPaths,
  offsetPolylineMeters,
  parkingRenderGeometry,
  simplifiedZoneGeometry,
  simplifyRenderGeometry,
} from '../utils/parkingGeometry';
import { LatLng } from '../types/parking';
import { haversineDistance } from '../utils/geo';

describe('simplifiedZoneGeometry (cached parking-zone RDP)', () => {
  // A closed square ring with a redundant collinear midpoint on the bottom edge.
  const ring: LatLng[] = [
    { latitude: 0, longitude: 0 },
    { latitude: 0, longitude: 0.5 }, // collinear midpoint — should be dropped
    { latitude: 0, longitude: 1 },
    { latitude: 1, longitude: 1 },
    { latitude: 1, longitude: 0 },
    { latitude: 0, longitude: 0 }, // closing point
  ];

  it('reduces the vertex count while preserving the closed ring', () => {
    const out = simplifiedZoneGeometry(ring, 6, 4);
    expect(out.length).toBeLessThan(ring.length);
    expect(out.length).toBeGreaterThanOrEqual(4); // still a valid polygon
    expect(out[0]).toEqual(out[out.length - 1]);   // still closed
  });

  it('never mutates the input geometry', () => {
    const lengthBefore = ring.length;
    const first = { ...ring[0] };
    simplifiedZoneGeometry(ring, 6, 4);
    expect(ring.length).toBe(lengthBefore);
    expect(ring[0]).toEqual(first);
  });

  it('returns the same cached reference on repeat calls (no re-simplification)', () => {
    const a = simplifiedZoneGeometry(ring, 6, 4);
    const b = simplifiedZoneGeometry(ring, 6, 4);
    expect(b).toBe(a);
  });

  it('falls back to the original when the input is already minimal', () => {
    const line: LatLng[] = [
      { latitude: 0, longitude: 0 },
      { latitude: 0, longitude: 1 },
    ];
    // length (2) is not > minPoints (2) → returns the original reference.
    expect(simplifiedZoneGeometry(line, 6, 2)).toBe(line);
  });
});

describe('street parking render geometry', () => {
  const eastbound: LatLng[] = [
    { latitude: 36.72, longitude: -4.42 },
    { latitude: 36.72, longitude: -4.4195 },
  ];
  const areaRing: LatLng[] = [
    { latitude: 36.72, longitude: -4.42 },
    { latitude: 36.72, longitude: -4.4198 },
    { latitude: 36.7202, longitude: -4.4198 },
    { latitude: 36.7202, longitude: -4.42 },
    { latitude: 36.72, longitude: -4.42 },
  ];

  it('offsets left/right relative to the OSM way direction in metres', () => {
    const left = offsetPolylineMeters(eastbound, 4.2);
    const right = offsetPolylineMeters(eastbound, -4.2);

    expect(left[0].latitude).toBeGreaterThan(eastbound[0].latitude);
    expect(right[0].latitude).toBeLessThan(eastbound[0].latitude);
    expect(haversineDistance(left[0], eastbound[0])).toBeCloseTo(4.2, 1);
    expect(haversineDistance(right[0], eastbound[0])).toBeCloseTo(4.2, 1);
  });

  it('renders both sides as two independent paths without a connector', () => {
    const paths = buildStreetParkingPaths(eastbound, { __parking_sides: 'both' });
    expect(paths.map(path => path.side)).toEqual(['left', 'right']);
    expect(paths).toHaveLength(2);
    expect(paths[0].coordinates).toHaveLength(eastbound.length);
    expect(paths[1].coordinates).toHaveLength(eastbound.length);
  });

  it('never fills a closed highway carrying modern side-parking tags', () => {
    const closedCenterline = [
      { latitude: 36.72, longitude: -4.42 },
      { latitude: 36.72, longitude: -4.4198 },
      { latitude: 36.7202, longitude: -4.4198 },
      { latitude: 36.72, longitude: -4.42 },
    ];
    const render = parkingRenderGeometry(
      { __parking_geometry: 'street', __parking_sides: 'both' },
      closedCenterline,
      null,
    );

    expect(render.polygon).toBeNull();
    expect(render.lines).toHaveLength(2);
    expect(render.lines.every(line => line.coordinates[0].latitude ===
      line.coordinates[line.coordinates.length - 1].latitude)).toBe(true);
  });

  it('keeps an elongated separately mapped street-side bay as its original polygon', () => {
    const dLat = 4 / 111_320;
    const dLon = 30 / (111_320 * Math.cos(36.72 * Math.PI / 180));
    const rectangle: LatLng[] = [
      { latitude: 36.72, longitude: -4.42 },
      { latitude: 36.72, longitude: -4.42 + dLon },
      { latitude: 36.72 + dLat, longitude: -4.42 + dLon },
      { latitude: 36.72 + dLat, longitude: -4.42 },
      { latitude: 36.72, longitude: -4.42 },
    ];

    const render = parkingRenderGeometry({ parking: 'street_side' }, rectangle, null);
    expect(render.polygon).toBe(rectangle);
    expect(render.lines).toEqual([]);
  });

  it('keeps a known Malaga curb polygon unchanged', () => {
    const importedStreetSide: LatLng[] = [
      { latitude: 36.7272381, longitude: -4.4188314 },
      { latitude: 36.7272139, longitude: -4.4187938 },
      { latitude: 36.7278604, longitude: -4.4186775 },
      { latitude: 36.7278820, longitude: -4.4187208 },
      { latitude: 36.7272381, longitude: -4.4188314 },
    ];
    const render = parkingRenderGeometry(
      { amenity: 'parking', parking: 'street_side' },
      importedStreetSide,
      null,
    );
    expect(render.polygon).toBe(importedStreetSide);
    expect(render.lines).toEqual([]);
  });

  it('keeps a normal standalone parking area as a polygon', () => {
    const render = parkingRenderGeometry({ parking: 'surface' }, areaRing, null);
    expect(render.polygon).toBe(areaRing);
    expect(render.lines).toEqual([]);
  });

  it('rejects an open polygon fragment instead of letting the map auto-close it', () => {
    const open = areaRing.slice(0, -1);
    const render = parkingRenderGeometry({ parking: 'surface' }, open, null);
    expect(render.polygon).toBeNull();
    expect(render.lines).toEqual([]);
  });
});

describe('simplifyRenderGeometry — order matters for street-side offsets', () => {
  // A rounded street corner: a straight approach leg, an 8-segment quarter-
  // circle bend (radius 3 m — a realistic curb rounding), then a straight
  // exit leg. Reproduces the "zone geometry breaks when you zoom out" bug:
  // at medium LOD the corner used to be simplified (RDP) BEFORE offsetting it
  // into the left/right parking lines, which fed a coarsened path into the
  // offset's miter-join math and could plant an offset point off the true
  // parallel line — self-intersecting/spiky shapes at a real street corner.
  const originLat = 36.72, originLon = -4.42;
  const metersToLatLon = (dxMeters: number, dyMeters: number): LatLng => {
    const latitudeScale = Math.PI * 6_371_000 / 180;
    const cosLat = Math.cos(originLat * Math.PI / 180);
    return {
      latitude: originLat + dyMeters / latitudeScale,
      longitude: originLon + dxMeters / (latitudeScale * cosLat),
    };
  };
  const roundedCorner: LatLng[] = (() => {
    const radius = 3;
    const steps = 8;
    const points = [{ dx: -100, dy: 0 }];
    for (let i = 0; i <= steps; i++) {
      const angle = (i / steps) * (Math.PI / 2);
      points.push({ dx: radius * Math.sin(angle) - 60, dy: -radius * (1 - Math.cos(angle)) });
    }
    const last = points[points.length - 1];
    points.push({ dx: last.dx, dy: last.dy - 40 });
    return points.map(p => metersToLatLon(p.dx, p.dy));
  })();
  const tags = { __parking_geometry: 'street', __parking_sides: 'both' };
  const TOLERANCE = 6;

  it('offset-then-simplify only ever drops points — every remaining point is a real point on the true offset line', () => {
    const full = parkingRenderGeometry(tags, roundedCorner, null);
    const simplified = simplifyRenderGeometry(full, TOLERANCE);

    const isRealPoint = (p: LatLng, line: LatLng[]) =>
      line.some(q => Math.abs(q.latitude - p.latitude) < 1e-9 && Math.abs(q.longitude - p.longitude) < 1e-9);

    simplified.lines.forEach((line, i) => {
      expect(line.coordinates.length).toBeLessThan(full.lines[i].coordinates.length);
      for (const point of line.coordinates) {
        expect(isRealPoint(point, full.lines[i].coordinates)).toBe(true);
      }
    });
  });

  it('BUG (old order): simplify-then-offset can synthesize a point that is NOT on the true offset line', () => {
    const full = parkingRenderGeometry(tags, roundedCorner, null);
    const simplifiedCenterline = simplifiedZoneGeometry(roundedCorner, TOLERANCE, 2);
    const oldOrderGeometry = parkingRenderGeometry(tags, simplifiedCenterline, null);

    const isRealPoint = (p: LatLng, line: LatLng[]) =>
      line.some(q => Math.abs(q.latitude - p.latitude) < 1e-9 && Math.abs(q.longitude - p.longitude) < 1e-9);

    const anySynthesized = oldOrderGeometry.lines.some(line =>
      line.coordinates.some(point => !isRealPoint(point, full.lines[0].coordinates) &&
        !isRealPoint(point, full.lines[1].coordinates)));
    expect(anySynthesized).toBe(true);
  });
});
