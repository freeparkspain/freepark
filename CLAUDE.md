# FreePark — AI Project Context

## What This Project Is

A React Native (Expo) mobile app showing free parking spots in Málaga, Spain on an OpenStreetMap. Users can browse markers, filter for free-only parking, and tap markers to see details.

## Tech Decisions

- **react-native-maps + UrlTile**: OSM tiles are loaded as a tile overlay on a base MapView. `mapType="none"` removes the default basemap so only OSM renders.
- **Zustand**: Single flat store. `useFilteredSpots` is a derived selector exported from the store file — not a store slice.
- **NativeWind v4**: `className` prop on RN components. Config in `tailwind.config.js`, CSS entry in `global.css`, imported in `App.tsx`. `jsxImportSource: "nativewind"` in babel config handles JSX transform.
- **React Navigation Native Stack**: Two screens — `Map` and `ParkingDetails`. Params typed via `RootStackParamList` in `types/parking.ts`.
- **No Expo Router**: File-based routing is NOT used. Navigation is wired manually in `app/Navigation.tsx`.

## Data Layer

All parking data lives in `data/parkingSpots.json` (20 Málaga spots). The Zustand store imports this file directly. To move to a real API, replace the import in `store/parkingStore.ts` with a fetch and add loading/error state.

## Key Files

| File | Purpose |
|---|---|
| `App.tsx` | Entry — imports global CSS, renders Navigation |
| `app/Navigation.tsx` | NavigationContainer + Stack.Navigator |
| `store/parkingStore.ts` | Zustand store + `useFilteredSpots` selector |
| `screens/MapScreen.tsx` | Full-screen map, marker rendering, filter toggle |
| `screens/ParkingDetailsScreen.tsx` | Spot detail view, reads spot by ID from store |
| `components/ParkingMarker.tsx` | Memoised coloured pin per parking type |
| `components/FilterToggle.tsx` | Floating pill button — toggles free-only filter |
| `components/MapLegend.tsx` | Floating legend (bottom-left) |
| `data/parkingSpots.json` | Mock data — 20 spots across Málaga |
| `types/parking.ts` | `ParkingSpot`, `ParkingType`, `RootStackParamList` |

## Conventions

- All React components are named exports (not default), except `App.tsx`.
- Props interfaces are defined inline above the component.
- `StyleSheet.create` is used only where NativeWind `className` cannot apply (inside `Marker` children, `MapView`).
- `memo()` is applied to `ParkingMarker` to prevent re-renders on map pan/zoom. Always set `tracksViewChanges={false}` on static markers.
- No `any` — strict TypeScript throughout.

## Android Note

`react-native-maps` requires a Google Maps API key on Android even when using OSM tiles as an overlay. The key goes in `app.json` under `android.config.googleMaps.apiKey`. iOS uses Apple Maps natively with no key required.

## Adding a New Screen

1. Add a route name + params to `RootStackParamList` in `types/parking.ts`
2. Create the screen component in `screens/`
3. Register it in `app/Navigation.tsx`

## Adding New Filter Types

Extend `filterFreeOnly: boolean` in `store/parkingStore.ts` to a union type (e.g. `filterType: ParkingType | 'all'`) and update `useFilteredSpots` accordingly. Update `FilterToggle.tsx` to cycle through options.
