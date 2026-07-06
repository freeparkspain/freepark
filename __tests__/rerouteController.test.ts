import { RerouteController } from '../navigation/rerouteController';
import { NavigationConfig } from '../types/navigation';

const config: NavigationConfig = {
  offRouteThresholdMeters: 50,
  offRouteConfirmationsRequired: 3,
  rerouteCooldownMillis: 10_000,
  destinationArrivalRadiusMeters: 25,
  maxUsableAccuracyMeters: 40,
};

describe('RerouteController', () => {
  it('requires N consecutive off-route confirmations', () => {
    const c = new RerouteController(config);
    expect(c.update(true, 1000)).toBe(false); // 1
    expect(c.update(true, 2000)).toBe(false); // 2
    expect(c.update(true, 3000)).toBe(true);  // 3 → reroute
  });

  it('resets the streak when back on route', () => {
    const c = new RerouteController(config);
    c.update(true, 1000);
    c.update(true, 2000);
    expect(c.update(false, 2500)).toBe(false); // back on route resets
    expect(c.update(true, 3000)).toBe(false);  // streak restarts at 1
    expect(c.update(true, 3500)).toBe(false);  // 2
    expect(c.update(true, 4000)).toBe(true);   // 3
  });

  it('enforces a cooldown between reroutes', () => {
    const c = new RerouteController(config);
    c.update(true, 1000);
    c.update(true, 2000);
    expect(c.update(true, 3000)).toBe(true);
    c.markRerouted(3000);
    // Within cooldown — even with confirmations, no reroute.
    expect(c.update(true, 5000)).toBe(false);
    expect(c.update(true, 6000)).toBe(false);
    expect(c.update(true, 7000)).toBe(false);
    // After cooldown elapses.
    expect(c.update(true, 13_001)).toBe(true);
  });

  it('reset() clears streak and cooldown', () => {
    const c = new RerouteController(config);
    c.update(true, 1000);
    c.reset();
    expect(c.update(true, 1500)).toBe(false); // streak back to 1
  });
});
