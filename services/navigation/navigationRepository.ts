import { LatLng } from '../../types/parking';
import { NavigationError, NavigationRoute, RoutingConfig } from '../../types/navigation';
import { OsrmApiService, OsrmHttpApiService } from './osrmApiService';
import { mapOsrmToRoute } from './osrmMapper';
import { ROUTING_CONFIG } from '../../constants/navigation';

// ─── NavigationRepository ─────────────────────────────────────────────────────
// The app's routing seam. UI/engine depend only on this interface, so swapping
// the public OSRM for a self-hosted server (or a different provider entirely)
// means constructing a different repository — nothing else changes.

export interface NavigationRepository {
  getRoute(
    origin: LatLng,
    destination: LatLng,
    signal?: AbortSignal,
  ): Promise<NavigationRoute>;
}

export class OsrmNavigationRepository implements NavigationRepository {
  constructor(private readonly api: OsrmApiService) {}

  async getRoute(
    origin: LatLng,
    destination: LatLng,
    signal?: AbortSignal,
  ): Promise<NavigationRoute> {
    try {
      const raw = await this.api.fetchRoute(origin, destination, signal);
      return mapOsrmToRoute(raw);
    } catch (err) {
      // Preserve intentional cancellation so callers can ignore it silently.
      if (err instanceof Error && err.name === 'AbortError') throw err;
      // NavigationError already carries a user-facing RU message.
      if (err instanceof NavigationError) throw err;
      throw new NavigationError('Could not build the route', true);
    }
  }
}

/** Default wiring against the configured (public-by-default) OSRM endpoint. */
export function createDefaultNavigationRepository(
  config: RoutingConfig = ROUTING_CONFIG,
): NavigationRepository {
  return new OsrmNavigationRepository(new OsrmHttpApiService(config));
}
