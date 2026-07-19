import { NavigationSessionGuard } from '../navigation/navigationSession';

describe('NavigationSessionGuard', () => {
  it('makes a rapid second start the only current session', () => {
    const guard = new NavigationSessionGuard();
    const first = guard.begin();
    const second = guard.begin();

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(true);
  });

  it('invalidates an in-flight session on stop', () => {
    const guard = new NavigationSessionGuard();
    const session = guard.begin();

    guard.invalidate();

    expect(guard.isCurrent(session)).toBe(false);
  });

  it('immediately disposes a watcher that resolves after stop', () => {
    const guard = new NavigationSessionGuard();
    const session = guard.begin();
    const stop = jest.fn();

    guard.invalidate();

    expect(guard.adoptWatch(session, stop)).toBe(false);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('stops an adopted watcher exactly once on completion', () => {
    const guard = new NavigationSessionGuard();
    const session = guard.begin();
    const stop = jest.fn();

    expect(guard.adoptWatch(session, stop)).toBe(true);
    expect(guard.complete(session)).toBe(true);
    guard.invalidate();

    expect(stop).toHaveBeenCalledTimes(1);
  });

  it('does not let a late old watcher replace the current watcher', () => {
    const guard = new NavigationSessionGuard();
    const oldSession = guard.begin();
    const oldStop = jest.fn();
    const currentSession = guard.begin();
    const currentStop = jest.fn();

    expect(guard.adoptWatch(currentSession, currentStop)).toBe(true);
    expect(guard.adoptWatch(oldSession, oldStop)).toBe(false);
    guard.invalidate();

    expect(oldStop).toHaveBeenCalledTimes(1);
    expect(currentStop).toHaveBeenCalledTimes(1);
  });

  it('keeps only the third of three out-of-order route sessions alive', () => {
    const guard = new NavigationSessionGuard();
    const first = guard.begin();
    const second = guard.begin();
    const third = guard.begin();
    const firstStop = jest.fn();
    const secondStop = jest.fn();
    const thirdStop = jest.fn();

    // Simulate async watcher creation resolving A, C, then B.
    expect(guard.adoptWatch(first, firstStop)).toBe(false);
    expect(guard.adoptWatch(third, thirdStop)).toBe(true);
    expect(guard.adoptWatch(second, secondStop)).toBe(false);

    expect(guard.isCurrent(first)).toBe(false);
    expect(guard.isCurrent(second)).toBe(false);
    expect(guard.isCurrent(third)).toBe(true);
    expect(firstStop).toHaveBeenCalledTimes(1);
    expect(secondStop).toHaveBeenCalledTimes(1);
    expect(thirdStop).not.toHaveBeenCalled();
  });
});
