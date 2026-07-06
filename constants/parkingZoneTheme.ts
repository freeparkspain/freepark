// ─── Selected parking zone styling (pure — no react-native imports) ───────────
// Kept here (not inline in ParkingLayer) so it can be unit-tested without
// pulling in native map components. The zone is an AREA look — translucent fill
// + outline. Free = BLUE (matches the blue "P" marker); paid = orange (matches
// the "€" marker). Zones only render while browsing — never during turn-by-turn
// navigation (parking is hidden then) — so they never sit next to the route.

export interface ZoneStyle {
  fill:   string;
  stroke: string;
  width:  number;
}

export const SELECTED_ZONE: ZoneStyle = {
  fill:   'rgba(0,122,255,0.20)',   // translucent blue area
  stroke: '#0A5FD6',                // deep blue outline (matches the P badge)
  width:  3,
};

export const SELECTED_ZONE_PAID: ZoneStyle = {
  fill:   'rgba(249,115,22,0.20)',  // translucent orange area
  stroke: '#C2410C',                // deep orange outline (matches the € badge)
  width:  3,
};
