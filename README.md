# FreePark — Parking Map & Turn-by-Turn Navigation for Málaga

A React Native (Expo) mobile app that shows OpenStreetMap-sourced parking data (free, paid, and street parking) for Málaga, Spain, on a Google Maps basemap, with built-in turn-by-turn driving navigation powered by OSRM. Data is fetched live from the Overpass API, cached locally, clustered/simplified for performance, and rendered with zoom-dependent level of detail.

> Documentation scope: this file describes only what currently exists in the source tree. Sections below flag legacy/unused code explicitly rather than omitting it, since removing dead code is a separate decision from documenting it.

---

## Tech Stack

| Layer | Library / Tool |
|---|---|
| Framework | React Native + Expo SDK 54 (`expo@54.0.33`, pinned — see [Configuration](#configuration)) |
| Language | TypeScript (strict, no `any`) |
| Map | `react-native-maps` with `PROVIDER_GOOGLE` (Google basemap on iOS **and** Android) |
| Parking data source | OpenStreetMap via the Overpass API |
| Clustering | `supercluster` |
| Routing | OSRM (`router.project-osrm.org` by default, `steps=true` + `geometries=polyline6`) |
| GPS | `expo-location` |
| Voice guidance | `expo-speech` |
| State management | `zustand` (minimal — see [State Management](#state-management)) |
| Navigation (screens) | `@react-navigation/native` + native-stack |
| Styling | NativeWind v4 (Tailwind CSS for RN) |
| Persistence | `@react-native-async-storage/async-storage` |
| Tests | Jest + `ts-jest`, pure-logic unit tests only (no RTL) |

---

## Project Structure

```
App.tsx                        Entry point — imports global.css, renders <Navigation />
index.ts                       registerRootComponent(App)
app/Navigation.tsx             NavigationContainer + native-stack (Map, ParkingDetails)

screens/
  MapScreen.tsx                 Main screen: map, parking layer, search, navigation UI (native)
  MapScreen.web.tsx             Web fallback (react-native-maps has no web support)
  ParkingDetailsScreen.tsx      Static-data detail view (registered but unreachable — see below)

store/
  useParkingStore.ts            Zustand store (mostly legacy — see State Management)

data/
  parkingSpots.json             10 hardcoded static Málaga spots (legacy data path)

services/
  overpassService.ts            Overpass API client: mirror racing, queries, parsing
  parking/parkingDataProvider.ts  ParkingDataProvider interface + Overpass-backed impl
  parking/parkingTiles.ts       Slippy-map tile math, viewport size guard
  cache/parkingCache.ts         AsyncStorage wiring for the parking cache
  cache/parkingCacheModel.ts    Pure cache encode/decode/validation/coverage logic
  cache/keyValueStore.ts        Generic AsyncStorage helpers (safe read, clear)
  navigation/                   OSRM client, response mapping, polyline codec, instructions,
                                 routing repository, external-maps URL builder

navigation/                     Framework-free turn-by-turn engine (progress, rerouting,
                                 session guarding, location validation, voice guidance,
                                 geometry/bearing/camera/car-animation/route-matching helpers)

hooks/
  useMapParkings.ts              Parking fetch/cache orchestration (the real data engine)
  useGeometryLoader.ts           On-demand full-geometry fetch for a selected zone
  useClustering.ts                Supercluster wrapper with viewport padding
  useLOD.ts                       Empty stub — LOD logic now lives in constants/parkingLod.ts
  useNavigation.ts                Turn-by-turn state machine ("ViewModel")
  useNavigationCamera.ts          Following/free/overview camera modes
  useRouteProgress.ts             Splits route into completed/remaining segments
  useCarTracking.ts               Animated, route-snapped car marker position/bearing
  useDestinationSelection.ts      Reducer for destination selection (unused — see below)

components/
  ParkingLayer.tsx               Renders clusters, zone outlines, markers, selected zone
  ParkingMarker.tsx               "P" / "€" badge marker
  SpotMarker.tsx                  Legacy marker for ParkingSpot shape (unused)
  MapLegend.tsx                   Legend UI (unused)
  FilterToggle.tsx                Free/paid filter pill (active)
  SearchBar.tsx                   Photon-backed address search
  GeometryLoadingBar.tsx          Loading indicator bar
  LoadingOverlay.tsx              Spinner overlay (unused)
  AppIcon.tsx                     Ionicons wrapper
  NavigationPanel.tsx             Turn-by-turn overlay chrome (maneuver banner, trip bar)
  NavigationArrow.tsx             Animated car puck
  NavigationRoute.tsx             Layered route polyline rendering
  NavigationRecenterButton.tsx    Recenter FAB (free camera mode)
  RouteBottomSheet.tsx            Destination info + route preview/start sheet
  NearbyParkingSuggestion.tsx     Nearest-parking driving aid card

utils/
  geo.ts, parking.ts, parkingAccess.ts, parkingGeometry.ts, parkingCluster.ts, photon.ts

types/
  parking.ts                     RootStackParamList, ParkingSpot, OsmParking, LatLng, BBox, ...
  navigation.ts                  NavigationRoute, NavigationState, NavigationProgress, ...

constants/
  maps.ts, navigation.ts, navigationTheme.ts, parkingLod.ts, parkingZoneTheme.ts

__tests__/                       Jest unit tests for all pure/framework-free logic above

parking-layer.js                 Standalone vanilla-JS Leaflet prototype — NOT part of the app
stubs/empty.js                   Metro web-bundling shim (not app code)
```

---

## Application Architecture

### Entry & navigation shell

- `index.ts` calls `registerRootComponent(App)` (after importing `@expo/metro-runtime` for web/Metro support).
- `App.tsx` imports `global.css` (NativeWind) and renders `<Navigation />`. Nothing else.
- `app/Navigation.tsx` wraps a `NavigationContainer` around a native-stack navigator (`createNativeStackNavigator<RootStackParamList>`) with two routes:
  - **`Map`** → `MapScreen`
  - **`ParkingDetails`** → `ParkingDetailsScreen`, takes `{ spotId: string }`
- `RootStackParamList` and the core domain types (`ParkingSpot`, `OsmParking`, `LatLng`, `BBox`, `RouteInfo`, `SelectedDestination`) live in `types/parking.ts`.

**Note:** `ParkingDetails` is registered in the navigator but nothing in the app currently calls `navigation.navigate('ParkingDetails', ...)`. `MapScreen` implements its own bottom-sheet-based selection UI (`RouteBottomSheet`) instead of navigating to a separate screen, so `ParkingDetailsScreen` and the static `data/parkingSpots.json` it reads from are effectively legacy/unreachable in the current UX.

### State management

`store/useParkingStore.ts` is a Zustand store:

```ts
interface ParkingState {
  spots: ParkingSpot[];              // static data/parkingSpots.json (legacy)
  selectedSpot: ParkingSpot | null;  // legacy
  filterOnlyFree: boolean;           // ACTIVE — used by the live map
  setSelectedSpot: (spot) => void;   // legacy
  toggleFilterOnlyFree: () => void;  // ACTIVE
}
export const useFilteredSpots = (): ParkingSpot[] => ...  // derived selector (legacy)
```

Only `filterOnlyFree` / `toggleFilterOnlyFree` are used by the live app today (`FilterToggle` and `MapScreen` read/toggle this flag to filter the real OSM-sourced parking list). `spots`, `selectedSpot`, and `useFilteredSpots` are only consumed by the unreachable `ParkingDetailsScreen`. **The live parking dataset does not live in this store** — it lives in module-level caches inside `hooks/useMapParkings.ts`.

### Screens

- **`screens/MapScreen.tsx`** — the core screen (~1,500 lines). Renders a `react-native-maps` `MapView` with `PROVIDER_GOOGLE` and a custom style that hides POI/business/transit labels. It composes:
  - `useMapParkings()` for OSM parking fetch/cache
  - `useGeometryLoader()` for on-demand full zone geometry
  - `useNavigation()`, `useCarTracking()`, `useRouteProgress()`, `useNavigationCamera()` for turn-by-turn
  - `useParkingStore()` only for the `filterOnlyFree` flag

  It manages: long-press pins (reverse-geocoded via `expo-location`), search-result pins, cluster taps (zoom in), parking-zone taps (select + refine an entrance/driveway target), a throttled "nearest parking" scan while driving, and a manual **"Search this area"** button — the only trigger for new Overpass fetches (no auto-fetch on pan/zoom, by design). A local `RoutePreviewState` union (`idle | building | ready | error`) drives a two-stage flow: preview a route ("Show Route") then commit to it ("Start Navigation"), reusing the previewed route rather than re-fetching.
- **`screens/MapScreen.web.tsx`** — the web-platform variant Metro resolves automatically (react-native-maps has no web support). Shows an icon, an "unavailable on web" message, and the filter toggle. No map, no OSM data.
- **`screens/ParkingDetailsScreen.tsx`** — reads `route.params.spotId`, looks it up in the static seed dataset via the store, and renders a detail card. Unreachable in the current UI flow (see above).

---

## Parking Data: Fetching, Caching, Clustering, Rendering

### Data source

Live parking data comes from the **Overpass API** (`services/overpassService.ts`), not the static JSON file. Key design points:

- **Mirror racing**: 6 public Overpass mirrors are raced in parallel via `Promise.any`; the fastest responder is remembered and tried first next time. Mirrors that time out or return 429/503/504 are temporarily blacklisted, with a global cooldown if all mirrors fail.
- **Two separate mirror pools**: a `BULK_POOL` for viewport queries (shorter timeout) and a `GEO_POOL` for on-demand geometry queries (longer timeout), isolated so one slow bulk query can't starve geometry lookups.
- **Two-tier geometry loading**: the bulk viewport query uses `out center` (lightweight — position + tags only) to list all `amenity=parking` nodes/ways/relations plus street-side parking (`parking=street_side|lane`, `highway` ways tagged `parking:left/right/both`) in view. Full ring/line geometry (`out geom`) is fetched separately and only on demand — either for a single tapped parking (`fetchParkingGeometry`) or batched for all zones on screen once the camera crosses the medium-LOD zoom threshold (`fetchParkingGeometryBatch`).
- Street-parking tags are normalized (`normaliseStreetParkingTags`) into a uniform internal shape so downstream rendering doesn't need to special-case `highway` ways vs. dedicated parking polygons.
- A separate, radius-bounded query (`fetchParkingAccessContext`) fetches `parking_entrance` nodes and nearby `highway=service` ways around a *selected* parking, used to compute a precise routable destination point (see [Access-Point Resolution](#access-point-resolution)).

### Caching

- **`services/cache/parkingCacheModel.ts`** — pure, unit-tested cache logic. A `ParkingCacheSnapshot` holds `entries` (parking + timestamp) and `coverage` (rectangles that have already been successfully fetched, each with a fetch timestamp). Versioned decoding invalidates the old v1 cache format; corrupt JSON is dropped; stale entries (24h TTL) are pruned. `coveredFraction()` computes what fraction of a new viewport is already covered by prior fetches (via exact rectangle-union math) so a redundant fetch can be skipped once coverage reaches 90%. Size caps (`MAX_MEMORY_PARKINGS`, `MAX_PERSISTED_PARKINGS`, `MAX_CACHE_JSON_CHARS`) are enforced before writing to storage, dropping geometry from the oldest entries first.
- **`services/cache/parkingCache.ts`** / **`keyValueStore.ts`** — AsyncStorage wiring, plus a generic idempotent/concurrency-safe cache-clear primitive.
- **`hooks/useMapParkings.ts`** (~460 lines) — the real parking data engine. Module-level caches (`Map`s for parkings/timestamps, plus a coverage list) survive component remounts within a process. On first mount it hydrates from AsyncStorage once. `loadForRegion(region)` applies, in order: a minimum-zoom guard, a rate-limit cooldown, a coverage-fraction check (skip if already ≥90% covered), then fetches via the Overpass provider, validates the response, merges it into the cache (preserving previously-fetched geometry), evicts oldest entries past a memory cap, and persists (debounced) to AsyncStorage. `loadZoneGeometry(ids)` debounces and batches geometry requests for on-screen zones.
- **`hooks/useGeometryLoader.ts`** — per-selection geometry fetch with its own cache, so re-selecting the same parking never re-fetches.

### Clustering & level of detail

- **`hooks/useClustering.ts`** wraps `supercluster`. The spatial index is only rebuilt when the *set* of parking ids/positions changes (via a cheap signature string), not on every tag/geometry update; cluster computation for the current viewport (with 30% padding, to avoid markers popping during a gesture) runs on every pan/zoom. Clustering is active below zoom 13; above that, individual markers render.
- **Level of detail** (`constants/parkingLod.ts`): three zoom-dependent, mutually exclusive presentation modes — `low` (markers/clusters only), `medium` (simplified zone outlines), `high` (full-resolution outlines) — with hysteresis to avoid flicker at the threshold. LOD is recomputed only on settled camera movement (`handleRegionChangeComplete` in `MapScreen`), not per-frame. (`hooks/useLOD.ts` is now an empty stub; this logic moved into the constants file and `ParkingLayer`'s own viewport culling.)
- **`utils/parkingGeometry.ts`** turns raw OSM geometry into render-ready shapes: street parking becomes offset left/right lines (metre-projected miter-join offsetting), polygons are validated to reject degenerate rings, everything else falls back to a center line. Simplification (Ramer–Douglas–Peucker, via `utils/geo.ts`) is applied *after* building offset lines (simplifying first would corrupt the offset math on curves), and is cached by array reference in a `WeakMap`.

### Access-point resolution

`utils/parkingAccess.ts` computes the best point to actually route to for a selected parking (not always its centroid): it classifies the geometry as point/street/area, builds ranked candidates (polygon centroid, explicit `parking_entrance` nodes, service-road intersections/nearest points, street endpoints, boundary fallback, raw position — in that priority order), deduplicates near-identical candidates, and picks the closest valid one to the reference point (usually the user's current location). This runs immediately on tap using whatever geometry is cached, then refines asynchronously once `fetchParkingAccessContext` returns richer data.

### Rendering

`components/ParkingLayer.tsx` renders (as separate `memo`'d sub-trees to minimize native marker churn): cluster bubbles, zone outlines (simplified or full depending on LOD), fallback dots for point-only geometry, and an isolated always-rendered layer for the currently selected zone. It enforces render caps (max individual markers, zone outlines, fallback dots) as a safety net against pathological viewports. `components/ParkingMarker.tsx` renders the "P"/"€" badge with shared accent colors also reused by `NearbyParkingSuggestion`.

---

## Turn-by-Turn Navigation

Routing is provided by **OSRM** (public instance `https://router.project-osrm.org` by default, overridable via env var). The navigation engine itself is framework-free, pure TypeScript, and covered by unit tests in `__tests__/`.

### Pipeline

1. User selects a destination (parking marker, search result, or long-press pin). `RouteBottomSheet` shows destination info.
2. User taps **"Show Route"** → `MapScreen` calls `fetchOsrmRoute` (in `services/navigation/osrmNavigation.ts`) to preview a route without starting navigation.
3. User taps **"Start Navigation"** → `useNavigation().startPrepared(destination, route)` reuses the previewed route (no redundant fetch).
4. A `NavigationSessionGuard` (`navigation/navigationSession.ts`) issues a new session id, invalidating any prior in-flight permission/GPS/route work so stale async results can't leak into a new session.
5. Location permission is requested, an initial GPS fix is taken, and a `NavigationEngine` (`navigation/navigationEngine.ts`) is constructed from the route.
6. A GPS watcher (`navigation/locationProvider.ts`, wrapping `expo-location`) streams samples; each sample is validated (`navigation/locationValidation.ts`) and fed to `engine.computeProgress()`, which resolves the current maneuver based on along-route progress (not raw distance, to avoid misfiring near parallel roads) and detects arrival via straight-line distance to the destination.
7. `VoiceGuidanceManager` (`expo-speech`) announces each maneuver in staged steps (early warning, ~200m, ~50m, "now"), deduplicated per step.
8. If GPS drifts off-route, `RerouteController` requires several consecutive off-route samples plus a cooldown before triggering a reroute, which fetches a fresh route from the current position and swaps it in.
9. On arrival (within the configured radius), the session is torn down and an arrival state is shown.

### Supporting modules

| File | Role |
|---|---|
| `types/navigation.ts` | Domain types: `NavigationRoute`, `NavigationStep`, `NavigationState` (state machine), `NavigationProgress`, camera/car-tracking config types |
| `constants/navigation.ts` | `ROUTING_CONFIG` (OSRM base URL, timeout), `NAVIGATION_CONFIG` (off-route/reroute/arrival tuning), camera and car-animation config |
| `services/navigation/osrmApiService.ts` | OSRM HTTP client — builds the request URL, combines internal timeout with caller `AbortSignal` |
| `services/navigation/osrmMapper.ts` | Maps raw OSRM JSON to the app's domain `NavigationRoute`, rejecting invalid/oversized/ferry-heavy routes |
| `services/navigation/osrmTypes.ts` | Raw OSRM wire-format types (never used outside the mapper) |
| `services/navigation/polyline.ts` | Polyline6 decode/encode |
| `services/navigation/instructionGenerator.ts` | Builds English maneuver instruction text from OSRM maneuver type/modifier |
| `services/navigation/navigationRepository.ts` | Routing seam — `OsrmNavigationRepository` is the default implementation |
| `services/navigation/externalMaps.ts` | Builds a Google Maps directions URL for a destination (not currently wired to any UI button) |
| `navigation/navigationEngine.ts` | Pure progress/maneuver/arrival computation from route + location |
| `navigation/geometry.ts` | Route projection/snapping math |
| `navigation/rerouteController.ts` | Off-route confirmation + cooldown state machine |
| `navigation/locationProvider.ts` | GPS abstraction (`expo-location`-backed) |
| `navigation/locationValidation.ts` | GPS sample validity/freshness checks |
| `navigation/voiceGuidanceManager.ts` | Staged English TTS announcements |
| `navigation/format.ts` | English distance/duration/ETA formatting |
| `navigation/services/bearing.ts` | Heading resolution from GPS/route data |
| `navigation/services/cameraLogic.ts` | Camera bearing, padding, speed-adaptive zoom |
| `navigation/services/carAnimation.ts` | Animation duration / teleport-vs-glide detection for the car marker |
| `navigation/services/routeMatcher.ts` | Snaps GPS position onto the route geometry |
| `navigation/services/routeProgress.ts` | Splits the route into completed/remaining segments |
| `navigation/services/routeValidator.ts` | Route/coordinate/bounds sanity checks |

### Hooks and UI

- **`hooks/useNavigation.ts`** — the turn-by-turn "ViewModel"; exposes `{ state, route, location, destination, isActive, start, startPrepared, stop, toggleMute, setFollowing, recenter }`. Dependencies (routing repository, location provider, voice manager) are injectable, enabling unit testing with fakes.
- **`hooks/useNavigationCamera.ts`** — owns the camera mode (`following | free | overview`); animates the map to follow the car while in `following` mode, switches to `free` only on a genuine user gesture.
- **`hooks/useCarTracking.ts`** — animates the car marker's position and rotation smoothly between GPS samples, snapped to the route.
- **`hooks/useRouteProgress.ts`** — splits the route into "completed" and "remaining" for two-tone rendering.
- **`components/NavigationPanel.tsx`** — the turn-by-turn overlay: maneuver banner (icon, distance, instruction, street name) and a bottom trip bar (remaining time/distance, ETA, recenter/mute/end controls).
- **`components/NavigationArrow.tsx`** — the animated car puck rendered on the map.
- **`components/NavigationRoute.tsx`** — the layered route polyline (casing/main/highlight/completed).
- **`components/RouteBottomSheet.tsx`** — destination info and the preview → start navigation flow.
- **`components/NearbyParkingSuggestion.tsx`** — shows the nearest known parking to the live position while driving.
- **`components/SearchBar.tsx`** — address search backed by the Photon geocoding API (`utils/photon.ts`), debounced with request cancellation for stale queries.

---

## Configuration

Environment variables (see `.env.example`), consumed by `app.config.js` and `constants/`:

| Variable | Required | Purpose |
|---|---|---|
| `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` | Yes | Native Google Maps SDK key, injected into both `ios.config.googleMapsApiKey` and `android.config.googleMaps.apiKey` in `app.config.js` |
| `EXPO_PUBLIC_OSRM_BASE_URL` | No | Overrides the OSRM routing endpoint (defaults to the public `router.project-osrm.org`, suitable for development only) |

- `app.config.js` is a **dynamic** Expo config (no static `app.json`); bundle/package id is `com.freepark.app`.
- `PROVIDER_GOOGLE` forces the Google basemap on both iOS and Android. This requires a dev/prebuild — in Expo Go on iOS the map provider falls back to Apple Maps.
- `package.json` intentionally pins `expo@54.0.33` and excludes `expo` from auto-install upgrades, per an inline comment: the `54.0.35` patch destabilized the Jest/Babel transform chain used by the test suite.
- `babel.config.js` uses `jsxImportSource: 'react-native-css-interop'` (not `'nativewind'`) due to a package-layout quirk in NativeWind v4.2.3, with the Reanimated Babel plugin loaded last.
- `metro.config.js` wraps NativeWind's transformer and adds custom module resolution: a no-op stub (`stubs/empty.js`) for a native-only accessibility function when bundling for web, and a fix for `Platform` module resolution on native.

---

## Testing

```bash
npm test        # Jest, __tests__/**
npm run lint     # expo lint
```

`jest.config.js` scopes the test suite to `__tests__/` only, running under `testEnvironment: 'node'` with `ts-jest`. Tests cover pure, framework-free logic exclusively (navigation engine, OSRM mapping/instructions, parking cache model, clustering signature, geometry/access-point math, bearing/camera/car-animation math, format helpers, etc.) — there is no React Native Testing Library / component-render suite, by deliberate choice (a prior attempt was dropped due to fragility against the exact React 19.1.0 / Expo SDK 54.0.33 combination).

---

## Running the App

```bash
npm install
npm run ios       # or: npm run android / npm run web
```

Requires a `.env` file with `EXPO_PUBLIC_GOOGLE_MAPS_API_KEY` set (see `.env.example`). Because `PROVIDER_GOOGLE` is forced, testing the map on iOS requires a dev-client/prebuild rather than plain Expo Go.

---

## Known Legacy / Unused Code

For accuracy, the following exist in the source tree but are not part of the live app's control flow (confirmed by the absence of any importing caller, aside from their own unit tests where present):

- `data/parkingSpots.json`, `store/useParkingStore.ts`'s `spots`/`selectedSpot`/`useFilteredSpots`, and `screens/ParkingDetailsScreen.tsx` — the original static-data path; the `ParkingDetails` route is registered but never navigated to.
- `hooks/useDestinationSelection.ts` — a reducer-based destination-selection state machine; `MapScreen` manages the equivalent state with separate `useState` calls instead.
- `components/SpotMarker.tsx`, `components/MapLegend.tsx`, `components/LoadingOverlay.tsx` — not imported anywhere.
- `hooks/useLOD.ts` — emptied out; superseded by `constants/parkingLod.ts` and viewport culling in `ParkingLayer.tsx`.
- `services/navigation/externalMaps.ts` — builds/opens an external Google Maps directions URL; implemented and tested but not yet wired to a UI button.
- `constants/maps.ts`'s `NAVIGATION_PROVIDER` env switch (`google`/`osrm`) — routing is currently hardcoded to OSRM via `constants/navigation.ts`; this switch does not appear to be read elsewhere.
- `parking-layer.js` (repo root) — a standalone vanilla-JS Leaflet prototype using a global `L`, excluded from ESLint and not part of the Metro/TypeScript build. Not shipped with the app.
- `stubs/empty.js` — not app code; a Metro build-time shim substituted for a native-only module when bundling for web.
