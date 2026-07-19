import {
  buildParkingAccessCandidates,
  chooseBestParkingAccessCandidate,
  classifyParkingGeometry,
  parkingPolygonCenter,
  resolveParkingRouteTarget,
} from '../utils/parkingAccess';
import type { LatLng } from '../types/parking';

const point = (latitude: number, longitude: number): LatLng => ({ latitude, longitude });

const area = [
  point(36.7000, -4.4200),
  point(36.7000, -4.4198),
  point(36.7002, -4.4198),
  point(36.7002, -4.4200),
];

describe('parking access geometry', () => {
  it('classifies valid area, street, and point geometries', () => {
    expect(classifyParkingGeometry({ polygon: area })).toBe('area');
    expect(classifyParkingGeometry({ polyline: area.slice(0, 2) })).toBe('street');
    expect(classifyParkingGeometry({ position: point(36.7, -4.42) })).toBe('point');
  });

  it('always routes a selected polygon to its geometric centre', () => {
    const explicitEntrance = point(36.7000, -4.4198);
    const target = resolveParkingRouteTarget({
      polygon: area,
      position: point(36.7001, -4.4199),
      explicitEntrances: [explicitEntrance],
      serviceWays: [[point(36.6999, -4.4199), point(36.7001, -4.4199)]],
      reference: point(36.7003, -4.4200),
    });

    expect(target?.source).toBe('polygon-center');
    expect(target?.position.latitude).toBeCloseTo(36.7001, 7);
    expect(target?.position.longitude).toBeCloseTo(-4.4199, 7);
  });

  it('computes an area-weighted centre without bias from a repeated closing vertex', () => {
    const closedArea = [...area, area[0]];
    const center = parkingPolygonCenter(closedArea);

    expect(center?.latitude).toBeCloseTo(36.7001, 7);
    expect(center?.longitude).toBeCloseTo(-4.4199, 7);
  });

  it('keeps a nearby service fallback on the drivable service way', () => {
    // The service way stops about 4.5 m east of the parking. The boundary is
    // used to validate proximity, but the navigation target stays on the road.
    const candidates = buildParkingAccessCandidates({
      polygon: area,
      serviceWays: [[point(36.7001, -4.41975), point(36.7001, -4.4196)]],
      reference: point(36.7001, -4.4196),
    });
    const serviceCandidate = candidates.find(candidate => candidate.source === 'service-nearest');

    expect(serviceCandidate).toBeDefined();
    expect(serviceCandidate!.position.longitude).toBeCloseTo(-4.41975, 7);
    expect(serviceCandidate!.position.latitude).toBeCloseTo(36.7001, 7);
    expect(serviceCandidate!.position).not.toEqual(area[1]);
    expect(serviceCandidate!.position).not.toEqual(area[2]);
  });

  it('chooses the street endpoint nearest the user', () => {
    const street = [
      point(36.7000, -4.4210),
      point(36.7000, -4.4200),
      point(36.7000, -4.4190),
    ];
    const target = resolveParkingRouteTarget({
      polyline: street,
      reference: point(36.7000, -4.4189),
    });

    expect(target?.source).toBe('street-endpoint');
    expect(target?.position).toEqual(street[2]);
  });

  it('uses the polygon centre instead of its nearest edge', () => {
    const target = resolveParkingRouteTarget({
      polygon: area,
      position: point(36.7001, -4.4199),
      reference: point(36.7001, -4.4195),
    });

    expect(target?.source).toBe('polygon-center');
    expect(target?.position.longitude).toBeCloseTo(-4.4199, 7);
    expect(target?.position.latitude).toBeCloseTo(36.7001, 7);
    expect(area).not.toContainEqual(target?.position);
  });

  it('rejects invalid coordinates and deterministically removes duplicates', () => {
    const validEntrance = point(36.7001, -4.4198);
    const invalid = { latitude: Number.NaN, longitude: -4.42 } as LatLng;
    const outOfRange = { latitude: 95, longitude: -4.42 } as LatLng;
    const candidates = buildParkingAccessCandidates({
      polygon: [invalid, ...area, outOfRange],
      explicitEntrances: [invalid, validEntrance, { ...validEntrance }, outOfRange],
      serviceWays: [[invalid, outOfRange]],
      reference: point(36.7003, -4.4198),
    });

    expect(candidates.every(candidate => Number.isFinite(candidate.position.latitude))).toBe(true);
    expect(candidates.filter(candidate => candidate.source === 'explicit-entrance')).toHaveLength(1);
    expect(chooseBestParkingAccessCandidate(candidates)?.source).toBe('polygon-center');
  });

  it('keeps service intersections available but selects the polygon centre', () => {
    const candidates = buildParkingAccessCandidates({
      polygon: area,
      serviceWays: [[point(36.7001, -4.4201), point(36.7001, -4.4197)]],
      reference: point(36.7001, -4.4195),
    });
    const intersection = candidates.find(candidate => candidate.source === 'service-intersection');
    const target = chooseBestParkingAccessCandidate(candidates);

    expect(target?.source).toBe('polygon-center');
    expect(intersection?.position.latitude).toBeCloseTo(36.7001, 7);
    // The user is east of the parking, so the east of the two equal-priority
    // intersections wins deterministically.
    expect(intersection?.position.longitude).toBeCloseTo(-4.4198, 7);
  });

  it('does not attach an unrelated nearby garage entrance to a street zone', () => {
    const street = [point(36.7, -4.421), point(36.7, -4.419)];
    const target = resolveParkingRouteTarget({
      polyline: street,
      explicitEntrances: [point(36.7, -4.42)],
      reference: point(36.7, -4.4189),
    });

    expect(target?.source).toBe('street-endpoint');
    expect(target?.position).toEqual(street[1]);
  });
});
