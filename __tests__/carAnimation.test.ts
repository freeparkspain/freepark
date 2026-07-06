import { computeAnimationDurationMs, isLargeJump } from '../navigation/services/carAnimation';
import { CarAnimationConfig } from '../types/navigation';

const config: CarAnimationConfig = {
  minimumDurationMs: 250,
  maximumDurationMs: 1_200,
  immediateJumpThresholdMeters: 150,
};

describe('computeAnimationDurationMs', () => {
  it('matches the GPS interval when within bounds', () => {
    expect(computeAnimationDurationMs(20, 500, config)).toBe(500);
  });
  it('clamps to the minimum for very frequent updates', () => {
    expect(computeAnimationDurationMs(5, 100, config)).toBe(250);
  });
  it('clamps to the maximum for long gaps', () => {
    expect(computeAnimationDurationMs(50, 5000, config)).toBe(1_200);
  });
  it('falls back to a distance-based estimate when dt is invalid', () => {
    const d = computeAnimationDurationMs(60, 0, config);
    expect(d).toBeGreaterThanOrEqual(config.minimumDurationMs);
    expect(d).toBeLessThanOrEqual(config.maximumDurationMs);
  });
});

describe('isLargeJump', () => {
  it('flags jumps beyond the threshold (teleport instead of glide)', () => {
    expect(isLargeJump(200, config)).toBe(true);
    expect(isLargeJump(50, config)).toBe(false);
  });
});
