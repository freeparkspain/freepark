/**
 * Monotonic owner token for one navigation attempt.
 *
 * Every async continuation (permission, one-shot GPS, route fetch and watcher
 * creation) must still own the same token before it is allowed to commit. The
 * guard also owns the live GPS disposer so a watcher that resolves after a
 * stop/restart is disposed immediately instead of leaking into a newer route.
 */
export class NavigationSessionGuard {
  private generation = 0;
  private activeGeneration: number | null = null;
  private watchStop: (() => void) | null = null;

  /** Begin a new latest-wins session and invalidate the previous one. */
  begin(): number {
    this.stopWatch();
    const sessionId = ++this.generation;
    this.activeGeneration = sessionId;
    return sessionId;
  }

  isCurrent(sessionId: number): boolean {
    return this.activeGeneration === sessionId;
  }

  /**
   * Adopt a watcher only while its creating session is still current.
   * A late watcher is stopped synchronously and never becomes observable.
   */
  adoptWatch(sessionId: number, stop: () => void): boolean {
    if (!this.isCurrent(sessionId)) {
      safelyStop(stop);
      return false;
    }

    this.stopWatch();
    this.watchStop = once(stop);
    return true;
  }

  /** Finish a terminal state (error/arrival) without affecting a newer session. */
  complete(sessionId: number): boolean {
    if (!this.isCurrent(sessionId)) return false;
    this.activeGeneration = null;
    this.generation++;
    this.stopWatch();
    return true;
  }

  /** Invalidate the current attempt, e.g. stop or component unmount. */
  invalidate(): void {
    this.activeGeneration = null;
    this.generation++;
    this.stopWatch();
  }

  private stopWatch(): void {
    const stop = this.watchStop;
    this.watchStop = null;
    if (stop) safelyStop(stop);
  }
}

function once(fn: () => void): () => void {
  let called = false;
  return () => {
    if (called) return;
    called = true;
    safelyStop(fn);
  };
}

function safelyStop(stop: () => void): void {
  try {
    stop();
  } catch {
    // Native subscription cleanup must never prevent the rest of teardown.
  }
}
