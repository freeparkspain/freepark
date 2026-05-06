# FreePark — Free Parking Map for Málaga

A production-ready React Native (Expo) app to find and browse free parking spots in Málaga, Spain. Displays OpenStreetMap tiles with colour-coded parking markers and a one-tap filter to show only free spots.

---

## Tech Stack

| Layer      | Library                                   |
| ---------- | ----------------------------------------- |
| Framework  | React Native + Expo SDK 51                |
| Language   | TypeScript (strict)                       |
| Map        | react-native-maps + OpenStreetMap UrlTile |
| State      | Zustand                                   |
| Navigation | React Navigation (Native Stack)           |
| Styling    | NativeWind v4 (Tailwind CSS)              |

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
