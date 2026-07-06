import { readFileSync } from 'fs';
import { join } from 'path';
import { SELECTED_ZONE, SELECTED_ZONE_PAID } from '../constants/parkingZoneTheme';
import { NAV_ROUTE_STYLE } from '../constants/navigationTheme';

describe('Parking zone renders as a translucent AREA (blue free / orange paid)', () => {
  // Zones only render while browsing — never during turn-by-turn navigation
  // (parking is hidden then), so they never sit beside the route. The zone is
  // a translucent-fill area (the route has no fill), and the free zone is blue
  // to match the "P" marker.
  it('free zone is blue (matches the P marker), paid zone is orange', () => {
    expect(SELECTED_ZONE.stroke.toLowerCase()).toBe('#0a5fd6');     // deep blue
    expect(SELECTED_ZONE_PAID.stroke.toLowerCase()).toBe('#c2410c'); // deep orange
  });

  it('zone outline is thinner than the route main line (reads as an area, not a path)', () => {
    expect(SELECTED_ZONE.width).toBeLessThan(NAV_ROUTE_STYLE.mainWidth);
    expect(SELECTED_ZONE_PAID.width).toBeLessThan(NAV_ROUTE_STYLE.mainWidth);
  });

  it('zone has a translucent fill, while the route line has no fill', () => {
    const alpha = (rgba: string) => Number(rgba.replace(/rgba?\(|\)/g, '').split(',')[3]);
    expect(alpha(SELECTED_ZONE.fill)).toBeGreaterThan(0);
    expect(alpha(SELECTED_ZONE.fill)).toBeLessThan(0.5);
    expect(alpha(SELECTED_ZONE_PAID.fill)).toBeGreaterThan(0);
    // The route style exposes no fill at all.
    expect((NAV_ROUTE_STYLE as { fill?: string }).fill).toBeUndefined();
  });
});

describe('BUG 7 — no loading spinner is rendered inside a parking marker', () => {
  it('ParkingMarker source contains no ActivityIndicator (never a spinner-as-marker)', () => {
    const src = readFileSync(join(__dirname, '../components/ParkingMarker.tsx'), 'utf8');
    expect(src).not.toContain('ActivityIndicator');
  });

  it('ParkingMarker always renders the P/€ glyph (no loading branch)', () => {
    const src = readFileSync(join(__dirname, '../components/ParkingMarker.tsx'), 'utf8');
    expect(src).toContain("paid ? '€' : 'P'");
    // No isLoadingGeometry prop remains that could gate a spinner.
    expect(src).not.toContain('isLoadingGeometry');
  });
});
