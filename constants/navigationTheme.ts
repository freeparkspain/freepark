// ─── Navigation route visual tokens ───────────────────────────────────────────
// Layered route styling so the line reads as a premium, map-agnostic ribbon
// (dark casing → accent core → soft inner highlight) over any basemap, with a
// muted "completed" trail behind the arrow. Widths/colors live here so they can
// be tuned in one place.

export interface NavigationRouteStyle {
  casingWidth:    number;
  casingColor:    string;
  mainWidth:      number;
  mainColor:      string;
  highlightWidth: number;
  highlightColor: string;
  completedWidth: number;
  completedColor: string;
}

export const NAV_ROUTE_STYLE: NavigationRouteStyle = {
  // Outer casing: dark translucent halo — keeps the line legible over light
  // streets, satellite imagery, water and green areas alike.
  casingWidth:    12,
  casingColor:    'rgba(2, 6, 23, 0.35)',
  // Primary active line: application accent blue.
  mainWidth:      7.5,
  mainColor:      '#2563EB',
  // Inner highlight: a thin soft-white core for a glossy, premium feel.
  highlightWidth: 2,
  highlightColor: 'rgba(255, 255, 255, 0.5)',
  // Completed trail: muted slate drawn OVER the accent so the travelled part
  // reads as "done" and attention stays on the road ahead. Must be AT LEAST as
  // wide as casingWidth — a narrower overlay (it used to match mainWidth, 7.5)
  // left a sliver of the dark casing halo visible on both edges of the
  // "completed" section, so the driven part never looked fully gone.
  completedWidth: 13,
  completedColor: 'rgba(100, 116, 139, 0.82)',
};

// Stable z-indices so layers never reorder / flicker during camera movement.
// `completed` sits ABOVE the main line so it visually mutes the travelled part.
export const NAV_ROUTE_Z = {
  casing:    20,
  main:      21,
  highlight: 22,
  completed: 23,
} as const;
