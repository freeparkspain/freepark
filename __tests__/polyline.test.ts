import { decodePolyline, decodePolyline6, encodePolyline } from '../services/navigation/polyline';

describe('polyline decoder', () => {
  it('decodes the canonical Google precision-5 polyline', () => {
    // Well-known reference vector from Google's polyline algorithm docs.
    const pts = decodePolyline('_p~iF~ps|U_ulLnnqC_mqNvxq`@', 5);
    expect(pts).toHaveLength(3);
    expect(pts[0].latitude).toBeCloseTo(38.5, 5);
    expect(pts[0].longitude).toBeCloseTo(-120.2, 5);
    expect(pts[1].latitude).toBeCloseTo(40.7, 5);
    expect(pts[1].longitude).toBeCloseTo(-120.95, 5);
    expect(pts[2].latitude).toBeCloseTo(43.252, 5);
    expect(pts[2].longitude).toBeCloseTo(-126.453, 5);
  });

  it('round-trips polyline6 coordinates within 1e-6', () => {
    const coords = [
      { latitude: 36.7213, longitude: -4.4214 },
      { latitude: 36.7250, longitude: -4.4300 },
      { latitude: 36.7300, longitude: -4.4100 },
      { latitude: 36.7412, longitude: -4.3998 },
    ];
    const decoded = decodePolyline6(encodePolyline(coords, 6));
    expect(decoded).toHaveLength(coords.length);
    decoded.forEach((p, i) => {
      expect(p.latitude).toBeCloseTo(coords[i].latitude, 6);
      expect(p.longitude).toBeCloseTo(coords[i].longitude, 6);
    });
  });

  it('returns an empty array for an empty string', () => {
    expect(decodePolyline6('')).toEqual([]);
  });
});
