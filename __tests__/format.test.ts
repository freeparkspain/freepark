import { formatDistanceEn, formatDurationEn, formatEta } from '../navigation/format';

describe('formatDistanceEn', () => {
  it('rounds metres below 100 to the metre', () => {
    expect(formatDistanceEn(85)).toBe('85 m');
    expect(formatDistanceEn(43)).toBe('43 m');
  });
  it('rounds to 10 m between 100 m and 1 km', () => {
    expect(formatDistanceEn(354)).toBe('350 m');
  });
  it('uses one decimal km up to 10 km', () => {
    expect(formatDistanceEn(1400)).toBe('1.4 km');
  });
  it('uses whole km above 10 km', () => {
    expect(formatDistanceEn(59000)).toBe('59 km');
  });
  it('never returns a negative distance', () => {
    expect(formatDistanceEn(-5)).toBe('0 m');
  });
});

describe('formatDurationEn', () => {
  it('shows minutes under an hour', () => {
    expect(formatDurationEn(1500)).toBe('25 min'); // 1500 s = 25 min
  });
  it('shows hours and minutes', () => {
    expect(formatDurationEn(4800)).toBe('1 h 20 min'); // 80 min
  });
  it('omits minutes when zero', () => {
    expect(formatDurationEn(7200)).toBe('2 h');
  });
});

describe('formatEta', () => {
  it('formats a 12-hour local clock', () => {
    const now = new Date(2020, 0, 1, 16, 22, 0); // 16:22 local
    expect(formatEta(25 * 60, now)).toBe('4:47 PM'); // +25 min → 16:47
  });
  it('handles midnight/noon boundaries', () => {
    expect(formatEta(0, new Date(2020, 0, 1, 0, 5, 0))).toBe('12:05 AM');
    expect(formatEta(0, new Date(2020, 0, 1, 12, 0, 0))).toBe('12:00 PM');
  });
});
