import {
  isFreshLocationSample,
  isValidLocationSample,
} from '../navigation/locationValidation';
import { LocationSample } from '../types/navigation';

function sample(timestampMs = 1_000): LocationSample {
  return {
    position: { latitude: 40, longitude: -3 },
    accuracyMeters: 10,
    bearingDegrees: 90,
    speedMps: 5,
    timestampMs,
  };
}

describe('location sample validation', () => {
  it('accepts a complete finite sample', () => {
    expect(isValidLocationSample(sample())).toBe(true);
  });

  it('rejects invalid coordinates, timestamps and sensor values', () => {
    expect(isValidLocationSample({ ...sample(), position: { latitude: 91, longitude: 0 } })).toBe(false);
    expect(isValidLocationSample({ ...sample(), timestampMs: Number.NaN })).toBe(false);
    expect(isValidLocationSample({ ...sample(), speedMps: -1 })).toBe(false);
    expect(isValidLocationSample({ ...sample(), bearingDegrees: 361 })).toBe(false);
  });

  it('rejects an old initial fix but tolerates small future clock skew', () => {
    expect(isFreshLocationSample(sample(1_000), 200_000, 10_000)).toBe(false);
    expect(isFreshLocationSample(sample(103_000), 100_000, 10_000)).toBe(true);
  });
});
