import {
  isFreeParking,
  isPaidParking,
  parkingFeeStatus,
  parkingName,
} from '../utils/parking';

describe('isPaidParking classification', () => {
  it('treats fee=yes and fee=paid as paid', () => {
    expect(isPaidParking({ fee: 'yes' })).toBe(true);
    expect(isPaidParking({ fee: 'paid' })).toBe(true);
    expect(isPaidParking({ 'parking:fee': 'yes' })).toBe(true);
  });

  it('treats only an explicit fee=no/free as free', () => {
    expect(isPaidParking({ fee: 'no' })).toBe(false);
    expect(isFreeParking({ fee: 'no' })).toBe(true);
    expect(isFreeParking({ fee: 'free' })).toBe(true);
  });

  it('does not mislabel missing fee data as free', () => {
    expect(parkingFeeStatus({})).toBe('unknown');
    expect(parkingFeeStatus({ amenity: 'parking' })).toBe('unknown');
    expect(isFreeParking({})).toBe(false);
  });
});

describe('parkingName', () => {
  it('prefers name, then English, then a default', () => {
    expect(parkingName({ id: 'w1', position: { latitude: 0, longitude: 0 }, polygon: null, polyline: null, tags: { name: 'Central' } })).toBe('Central');
    expect(parkingName({ id: 'w1', position: { latitude: 0, longitude: 0 }, polygon: null, polyline: null, tags: { 'name:en': 'Harbor' } })).toBe('Harbor');
    expect(parkingName({ id: 'w1', position: { latitude: 0, longitude: 0 }, polygon: null, polyline: null, tags: {} })).toBe('Parking');
  });
});
