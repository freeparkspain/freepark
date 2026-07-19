import {
  computeMapPadding,
  defaultMapPadding,
  drivingZoom,
  resolveRecenterBearing,
  shouldEnterFreeMode,
  shouldFocusNavigationSession,
} from '../navigation/services/cameraLogic';
import { MapViewportLayout } from '../types/navigation';

const layout: MapViewportLayout = {
  width: 390,
  height: 800,
  topOverlayHeight: 110,
  bottomOverlayHeight: 96,
  safeAreaTop: 47,
  safeAreaBottom: 34,
};

describe('resolveRecenterBearing', () => {
  const min = 1.5;
  it('uses reliable GPS heading when moving', () => {
    expect(resolveRecenterBearing({
      gpsBearing: 42, speedMps: 5, matchedSegmentBearing: 90,
      firstSegmentBearing: 10, mapBearing: 200, minReliableSpeedMps: min,
    })).toBe(42);
  });
  it('falls back to matched segment bearing when stopped', () => {
    expect(resolveRecenterBearing({
      gpsBearing: 42, speedMps: 0, matchedSegmentBearing: 90,
      firstSegmentBearing: 10, mapBearing: 200, minReliableSpeedMps: min,
    })).toBe(90);
  });
  it('falls back to the first route segment before the car moves', () => {
    expect(resolveRecenterBearing({
      gpsBearing: null, speedMps: null, matchedSegmentBearing: null,
      firstSegmentBearing: 10, mapBearing: 200, minReliableSpeedMps: min,
    })).toBe(10);
  });
  it('finally falls back to map bearing, then north', () => {
    expect(resolveRecenterBearing({
      gpsBearing: null, speedMps: null, matchedSegmentBearing: null,
      firstSegmentBearing: null, mapBearing: 200, minReliableSpeedMps: min,
    })).toBe(200);
    expect(resolveRecenterBearing({
      gpsBearing: null, speedMps: null, matchedSegmentBearing: null,
      firstSegmentBearing: null, mapBearing: null, minReliableSpeedMps: min,
    })).toBe(0);
  });
});

describe('computeMapPadding', () => {
  it('biases the target downward so the car sits below centre', () => {
    const pad = computeMapPadding(layout, 0.7);
    expect(pad.top).toBeGreaterThan(pad.bottom);
    // padTop - padBottom ≈ (2*0.7 - 1)*height = 0.4*800 = 320
    expect(pad.top - pad.bottom).toBeCloseTo(320, 0);
    expect(pad.bottom).toBe(layout.safeAreaBottom + layout.bottomOverlayHeight);
  });
  it('never collapses the viewport (clamped to 60% height)', () => {
    const pad = computeMapPadding(layout, 0.95);
    expect(pad.top).toBeLessThanOrEqual(layout.height * 0.6);
  });
});

describe('defaultMapPadding', () => {
  it('reserves overlay + safe-area space only', () => {
    const pad = defaultMapPadding(layout);
    expect(pad.top).toBe(layout.safeAreaTop + layout.topOverlayHeight);
    expect(pad.bottom).toBe(layout.safeAreaBottom + layout.bottomOverlayHeight);
  });
});

describe('drivingZoom', () => {
  const base = 16.5;
  it('keeps the base zoom at low/stopped speed', () => {
    expect(drivingZoom(0, base)).toBe(base);
    expect(drivingZoom(null, base)).toBe(base);
    expect(drivingZoom(3, base)).toBe(base);
  });
  it('zooms out progressively as speed rises (more road ahead)', () => {
    const city = drivingZoom(6, base);      // ~14–32 km/h
    const arterial = drivingZoom(12, base);  // ~32–58 km/h
    const highway = drivingZoom(20, base);   // > ~58 km/h
    expect(city).toBeLessThan(base);
    expect(arterial).toBeLessThan(city);
    expect(highway).toBeLessThan(arterial);
  });

  it('changes smoothly around speed thresholds', () => {
    expect(Math.abs(drivingZoom(4.01, base) - drivingZoom(3.99, base))).toBeLessThan(0.02);
    expect(Math.abs(drivingZoom(9.01, base) - drivingZoom(8.99, base))).toBeLessThan(0.02);
    expect(Math.abs(drivingZoom(16.01, base) - drivingZoom(15.99, base))).toBeLessThan(0.02);
  });

  it('gently zooms in for an approaching maneuver without exceeding the cap', () => {
    expect(drivingZoom(3, base, 75)).toBeGreaterThan(drivingZoom(3, base, 200));
    expect(drivingZoom(0, base, 0)).toBeLessThanOrEqual(base + 0.5);
  });
});

describe('shouldEnterFreeMode', () => {
  it('enters free only for a genuine user gesture while following', () => {
    expect(shouldEnterFreeMode(true, 'following')).toBe(true);
    expect(shouldEnterFreeMode(false, 'following')).toBe(false);
    expect(shouldEnterFreeMode(undefined, 'following')).toBe(false);
    expect(shouldEnterFreeMode(true, 'free')).toBe(false);
  });
});

describe('shouldFocusNavigationSession', () => {
  it('focuses once when a new session has both route and car position', () => {
    expect(shouldFocusNavigationSession(true, 2, true, 4, null)).toBe(true);
    expect(shouldFocusNavigationSession(true, 2, true, 4, 4)).toBe(false);
    expect(shouldFocusNavigationSession(true, 2, true, 5, 4)).toBe(true);
  });

  it('waits until navigation, route and car position are ready', () => {
    expect(shouldFocusNavigationSession(false, 2, true, 1, null)).toBe(false);
    expect(shouldFocusNavigationSession(true, 1, true, 1, null)).toBe(false);
    expect(shouldFocusNavigationSession(true, 2, false, 1, null)).toBe(false);
  });
});
