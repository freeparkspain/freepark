# FreePark — Free Parking Map for Málaga

A production-ready React Native (Expo) app to find and browse free parking spots in Málaga, Spain. Displays OpenStreetMap tiles with colour-coded parking markers and a one-tap filter to show only free spots.

---

## Tech Stack

| Layer      | Library                                   |
| ---------- | ----------------------------------------- |
| Framework  | React Native + Expo SDK 51                |
| Language   | TypeScript (strict)                       |
| Map        | react-native-maps (Google provider)       |
| State      | Zustand                                   |
| Navigation | React Navigation (Native Stack)           |
| Styling    | NativeWind v4 (Tailwind CSS)              |
| Routing    | OSRM (free/OSS) + polyline6               |
| GPS        | expo-location (FusedLocationProvider)     |
| Voice      | expo-speech (Android/iOS TTS)             |
| Tests      | Jest + ts-jest (pure logic)               |

---

## Turn-by-Turn Navigation

FreePark includes in-app turn-by-turn driving navigation built entirely on free
/ open-source pieces — no paid SDK or paid routing API.

- **Routing:** public OSRM (`https://router.project-osrm.org`) via `steps=true`
  + `geometries=polyline6`. All UI/voice text is **English**.
- **Guidance:** live GPS (expo-location), spoken maneuvers (expo-speech), automatic
  off-route rerouting, and arrival detection.
- **Start it:** pick any destination (parking marker / search result / long-press
  pin / nearest-parking card), then press **Start Route** in the bottom sheet.

### Module layout

| File | Role |
|---|---|
| `types/navigation.ts` | Domain models + `NavigationState` machine + config |
| `constants/navigation.ts` | `RoutingConfig` (OSRM base URL), tuning, voice stages |
| `services/navigation/osrmApiService.ts` | OSRM HTTP client (timeout, abort, HTTPS) |
| `services/navigation/osrmMapper.ts` | OSRM JSON → domain route (errors as `NavigationError`) |
| `services/navigation/navigationRepository.ts` | Routing seam — swap OSRM for your own server |
| `services/navigation/polyline.ts` | polyline6 encode/decode (precision 1e-6) |
| `services/navigation/instructionGenerator.ts` | English maneuver phrasing |
| `navigation/navigationEngine.ts` | Pure engine: progress, maneuver, off-route, arrival |
| `navigation/rerouteController.ts` | Confirmations + cooldown reroute guard |
| `navigation/locationProvider.ts` | `LocationProvider` (expo-location impl + fakeable interface) |
| `navigation/voiceGuidanceManager.ts` | Staged English TTS (en-US → en-GB → en) |
| `navigation/format.ts` | English distance / duration / ETA formatting |
| `hooks/useNavigation.ts` | Orchestration "ViewModel" wiring it all together |
| `components/NavigationPanel.tsx` | Top instruction card + bottom trip bar (safe-area) |

### Changing the OSRM endpoint

The public server is **development/testing only** (rate-limited, no SLA). For
production, deploy your own OSRM (or a compatible free endpoint) and set:

```bash
# .env
EXPO_PUBLIC_OSRM_BASE_URL=https://osrm.your-domain.com
```

No code changes are needed — `constants/navigation.ts` reads this env var and the
`NavigationRepository` interface isolates the rest of the app from the provider.

---

## Parking data

Parking is loaded per **viewport** (never city-wide) and pulled explicitly via the
**Search Parking** button — pan/zoom never auto-fetches. Requests are
latest-request-wins (`AbortController`), previously loaded spots stay visible while
a refresh runs, and results are cached in memory + AsyncStorage
(`freepark_v1_parkings`). Clearing is safe/idempotent via `clearParkingCache()`
(`services/cache/parkingCache.ts`).

The data source sits behind a **`ParkingDataProvider`** seam
(`services/parking/parkingDataProvider.ts`) — today `OverpassParkingDataProvider`
(public Overpass mirrors, dev/testing). Deterministic slippy-map tiles
(`services/parking/parkingTiles.ts`) give stable viewport identity and gate
over-large searches.

### Production backend migration

Public Overpass can't deliver Google-Maps latency at scale. For production, add a
`BackendParkingDataProvider` implementing the same interface against a cached
endpoint, e.g. `GET /api/parking?west&south&east&north&zoom`, backed by:
PostGIS bounding-box queries + spatial index, a Redis/CDN tile cache with ETag +
compression, result limits and stable de-duplication by `${type}:${id}`. Only
`defaultParkingDataProvider` changes — the hook and UI are untouched. A
vector-tile service is the ideal end state.

---

## Tests

```bash
npm test        # Jest — pure navigation + cache logic (no native modules)
npx tsc --noEmit
```

---

## How to Run

### 1. Install dependencies

```bash
npm install
```

### 2. Start the development server

```bash
npx expo start
```

Then press:

- `i` → iOS Simulator
- `a` → Android Emulator
- Scan QR code → Expo Go on a physical device

### Android: Google Maps API Key

`react-native-maps` uses Google Maps SDK on Android. You need an API key:

1. Get a key from the [Google Cloud Console](https://console.cloud.google.com/)
2. Enable the **Maps SDK for Android**
3. Replace `YOUR_GOOGLE_MAPS_ANDROID_KEY` in `app.json`

> iOS uses Apple Maps by default — no key required. OSM tiles overlay on both platforms.

---

## Project Structure

```
freepark/
├── App.tsx                     # Entry point
├── global.css                  # Tailwind directives (NativeWind v4)
├── app/
│   └── Navigation.tsx          # Stack navigator + NavigationContainer
├── components/
│   ├── ParkingMarker.tsx        # Coloured map pin per parking type
│   ├── FilterToggle.tsx         # Free-only filter button (floating UI)
│   └── MapLegend.tsx            # Colour legend overlay
├── screens/
│   ├── MapScreen.tsx            # Main map view
│   └── ParkingDetailsScreen.tsx # Spot detail view
├── store/
│   └── parkingStore.ts          # Zustand store + useFilteredSpots selector
├── data/
│   └── parkingSpots.json        # Mock parking data (20 Málaga spots)
└── types/
    └── parking.ts               # ParkingSpot, ParkingType, RootStackParamList
```

---

## How to Extend Parking Data

Add entries to `data/parkingSpots.json`. Each entry follows this shape:

```json
{
  "id": "21",
  "name": "My New Spot",
  "latitude": 36.72,
  "longitude": -4.418,
  "type": "free",
  "description": "Short description shown on the details screen.",
  "address": "Street name, Málaga",
  "maxHours": 2,
  "notes": "Optional extra info"
}
```

**Field reference:**

| Field         | Type                                | Required | Notes                               |
| ------------- | ----------------------------------- | -------- | ----------------------------------- |
| `id`          | string                              | Yes      | Must be unique                      |
| `name`        | string                              | Yes      | Shown on marker tooltip and details |
| `latitude`    | number                              | Yes      | Decimal degrees                     |
| `longitude`   | number                              | Yes      | Decimal degrees (negative = West)   |
| `type`        | `"free"` \| `"paid"` \| `"unknown"` | Yes      | Controls marker colour              |
| `description` | string                              | Yes      | Paragraph shown on details screen   |
| `address`     | string                              | No       | Shown as an info row                |
| `maxHours`    | number \| null                      | No       | `null` = no limit                   |
| `notes`       | string                              | No       | Shown as an info row                |

The store loads this file at startup — no API call needed. For real data, replace the JSON import in `store/parkingStore.ts` with a `fetch` call.

---

## Where to Modify Map Logic

| What to change                      | Where                                                                    |
| ----------------------------------- | ------------------------------------------------------------------------ |
| Initial map center / zoom           | `screens/MapScreen.tsx` → `MALAGA_REGION` constant                       |
| Map tile provider (OSM URL)         | `screens/MapScreen.tsx` → `<UrlTile urlTemplate="..." />`                |
| Marker colours / labels             | `components/ParkingMarker.tsx` → `TYPE_CONFIG`                           |
| Add filter types (e.g. "paid only") | `store/parkingStore.ts` → extend `filterFreeOnly` to a `filterType` enum |
| Navigation between screens          | `app/Navigation.tsx` + `types/parking.ts` → `RootStackParamList`         |
| Header colours / style              | `app/Navigation.tsx` → `screenOptions`                                   |

---

## Marker Colour Key

| Colour         | Type         |
| -------------- | ------------ |
| Blue `#3B82F6` | Free parking |
| Red `#EF4444`  | Paid parking |
| Gray `#6B7280` | Unknown      |

---

## Extending Further

- **Live data**: Swap `parkingSpots.json` for an API call in the store; add loading/error states.
- **User location**: `expo-location` is already permitted via `showsUserLocation` on the map.
- **Add parking**: Add a form screen that appends to the store and optionally POSTs to a backend.
- **Offline tiles**: Use `react-native-maps-offline-tile` for cached OSM tiles.
- **Cluster markers**: `react-native-map-clustering` for dense areas.
