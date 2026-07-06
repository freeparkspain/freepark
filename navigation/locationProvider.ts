import * as Location from 'expo-location';
import { LocationSample, NavigationError } from '../types/navigation';

// ─── LocationProvider ─────────────────────────────────────────────────────────
// Abstracts the GPS source behind an interface so the navigation hook can be
// driven by a fake in tests and the concrete expo-location implementation on
// device. Nothing above this layer touches expo-location directly.

export type LocationListener = (sample: LocationSample) => void;
export type LocationErrorListener = (error: NavigationError) => void;

export interface LocationProvider {
  /** Ask for foreground permission; resolves true only when granted. */
  ensurePermission(): Promise<boolean>;
  /** One-shot current fix (null if unavailable). */
  getCurrent(): Promise<LocationSample | null>;
  /** Subscribe to live updates; resolves to an unsubscribe function. */
  watch(onSample: LocationListener, onError?: LocationErrorListener): Promise<() => void>;
}

function toSample(loc: Location.LocationObject): LocationSample {
  const { latitude, longitude, accuracy, heading, speed } = loc.coords;
  return {
    position:       { latitude, longitude },
    accuracyMeters: accuracy != null && accuracy >= 0 ? accuracy : null,
    // expo reports heading/speed as -1 (or null) when unknown.
    bearingDegrees: heading != null && heading >= 0 ? heading : null,
    speedMps:       speed != null && speed >= 0 ? speed : null,
    timestampMs:    loc.timestamp,
  };
}

export class ExpoLocationProvider implements LocationProvider {
  async ensurePermission(): Promise<boolean> {
    try {
      const current = await Location.getForegroundPermissionsAsync();
      if (current.status === 'granted') return true;
      const req = await Location.requestForegroundPermissionsAsync();
      return req.status === 'granted';
    } catch {
      return false;
    }
  }

  async getCurrent(): Promise<LocationSample | null> {
    try {
      const enabled = await Location.hasServicesEnabledAsync();
      if (!enabled) return null;
      const loc = await Location.getCurrentPositionAsync({
        accuracy: Location.Accuracy.High,
      });
      return toSample(loc);
    } catch {
      return null;
    }
  }

  async watch(
    onSample: LocationListener,
    onError?: LocationErrorListener,
  ): Promise<() => void> {
    const enabled = await Location.hasServicesEnabledAsync();
    if (!enabled) {
      onError?.(new NavigationError('GPS is off. Enable location services', true));
      return () => {};
    }

    try {
      const sub = await Location.watchPositionAsync(
        {
          accuracy:         Location.Accuracy.BestForNavigation,
          // A sensible cadence for driving — ~1 s / 5 m, not every fix.
          timeInterval:     1_000,
          distanceInterval: 5,
        },
        (loc) => onSample(toSample(loc)),
      );
      return () => sub.remove();
    } catch {
      onError?.(new NavigationError('Could not get your location', true));
      return () => {};
    }
  }
}
