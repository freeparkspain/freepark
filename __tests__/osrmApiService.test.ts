import { buildOsrmRouteUrl } from '../services/navigation/osrmApiService';

describe('buildOsrmRouteUrl', () => {
  it('requests detailed guidance and multiple route alternatives', () => {
    const url = buildOsrmRouteUrl(
      { baseUrl: 'https://router.example', requestTimeoutMs: 5_000 },
      { latitude: 36.72, longitude: -4.42 },
      { latitude: 36.73, longitude: -4.41 },
    );

    expect(url).toContain('/route/v1/driving/-4.42,36.72;-4.41,36.73');
    expect(url).toContain('overview=full');
    expect(url).toContain('steps=true');
    expect(url).toContain('alternatives=3');
  });
});
