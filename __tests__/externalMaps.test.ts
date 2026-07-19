jest.mock('react-native', () => ({
  Linking: {
    canOpenURL: jest.fn(),
    openURL: jest.fn(),
  },
}));

import { Linking } from 'react-native';
import { buildExternalMapsUrl, openExternalMaps } from '../services/navigation/externalMaps';

describe('external maps', () => {
  it('builds an encoded cross-platform Google Maps directions URL', () => {
    expect(buildExternalMapsUrl({ latitude: 36.7213, longitude: -4.4214 })).toBe(
      'https://www.google.com/maps/dir/?api=1&destination=36.7213%2C-4.4214&travelmode=driving',
    );
  });

  it('rejects invalid coordinates before touching Linking', () => {
    expect(() => buildExternalMapsUrl({ latitude: Number.NaN, longitude: 0 })).toThrow(
      'Invalid destination coordinates',
    );
  });

  it('opens the universal URL when supported', async () => {
    jest.mocked(Linking.canOpenURL).mockResolvedValue(true);
    jest.mocked(Linking.openURL).mockResolvedValue(undefined);
    await openExternalMaps({ latitude: 1, longitude: 2 });
    expect(Linking.openURL).toHaveBeenCalledWith(
      'https://www.google.com/maps/dir/?api=1&destination=1%2C2&travelmode=driving',
    );
  });
});
