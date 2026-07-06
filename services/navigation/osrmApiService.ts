import { LatLng } from '../../types/parking';
import { NavigationError, RoutingConfig } from '../../types/navigation';
import { OsrmRouteResponse } from './osrmTypes';

// ─── OSRM HTTP client ─────────────────────────────────────────────────────────
// Thin transport layer: builds the request URL, enforces a timeout, and returns
// the raw OSRM JSON. All higher-level meaning lives in the mapper/repository.
// The interface exists so tests (and future providers) can supply a fake.

export interface OsrmApiService {
  fetchRoute(
    origin: LatLng,
    destination: LatLng,
    signal?: AbortSignal,
  ): Promise<OsrmRouteResponse>;
}

export class OsrmHttpApiService implements OsrmApiService {
  constructor(private readonly config: RoutingConfig) {}

  async fetchRoute(
    origin: LatLng,
    destination: LatLng,
    signal?: AbortSignal,
  ): Promise<OsrmRouteResponse> {
    // OSRM expects longitude,latitude — the OPPOSITE of Google's lat,lng.
    const coords =
      `${origin.longitude},${origin.latitude};` +
      `${destination.longitude},${destination.latitude}`;
    const url =
      `${this.config.baseUrl}/route/v1/driving/${coords}` +
      `?overview=full&geometries=polyline6&steps=true&alternatives=false`;

    // Combine an internal timeout with any caller-provided abort signal, so a
    // reroute superseding an in-flight request cancels it immediately.
    const timeoutCtrl = new AbortController();
    const timer = setTimeout(() => timeoutCtrl.abort(), this.config.requestTimeoutMs);
    const onExternalAbort = () => timeoutCtrl.abort();
    if (signal) {
      if (signal.aborted) timeoutCtrl.abort();
      else signal.addEventListener('abort', onExternalAbort, { once: true });
    }

    let response: Response;
    try {
      response = await fetch(url, { signal: timeoutCtrl.signal });
    } catch (err) {
      // Distinguish "we cancelled it" from a genuine network failure.
      if (signal?.aborted) {
        throw Object.assign(new Error('Aborted'), { name: 'AbortError' });
      }
      if (err instanceof Error && err.name === 'AbortError') {
        throw new NavigationError('Route request timed out', true);
      }
      throw new NavigationError('No connection to the routing server', true);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onExternalAbort);
    }

    if (!response.ok) {
      throw new NavigationError(`Routing server error (${response.status})`, true);
    }

    try {
      return (await response.json()) as OsrmRouteResponse;
    } catch {
      throw new NavigationError('Invalid response from the routing server', true);
    }
  }
}
