import { NavigationConfig } from '../types/navigation';

// ─── RerouteController (pure) ─────────────────────────────────────────────────
// Decides WHEN to trigger a reroute, defending against GPS noise and request
// storms. Rules:
//   • off-route must be confirmed by N consecutive samples (not a single blip);
//   • a cooldown must have elapsed since the last reroute;
//   • being back on-route resets the confirmation streak.
// The "only one request in flight" guard lives in the hook (it owns the async);
// this object is pure and unit-testable with an injected clock.

export class RerouteController {
  private consecutiveOffRoute = 0;
  private lastRerouteAtMs = Number.NEGATIVE_INFINITY;

  constructor(private readonly config: NavigationConfig) {}

  /** Call once per GPS sample. Returns true when a reroute should start now. */
  update(isOffRoute: boolean, nowMs: number): boolean {
    if (!isOffRoute) {
      this.consecutiveOffRoute = 0;
      return false;
    }

    this.consecutiveOffRoute++;

    if (this.consecutiveOffRoute < this.config.offRouteConfirmationsRequired) {
      return false;
    }
    if (nowMs - this.lastRerouteAtMs < this.config.rerouteCooldownMillis) {
      return false;
    }
    return true;
  }

  /** Record that a reroute has just been initiated (starts the cooldown). */
  markRerouted(nowMs: number): void {
    this.lastRerouteAtMs = nowMs;
    this.consecutiveOffRoute = 0;
  }

  /** Clear streak/cooldown, e.g. after a fresh route is applied. */
  reset(): void {
    this.consecutiveOffRoute = 0;
    this.lastRerouteAtMs = Number.NEGATIVE_INFINITY;
  }
}
