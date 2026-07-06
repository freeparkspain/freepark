// Dynamic Expo config (single source of truth — no static app.json).
// Injects the native Google Maps SDK keys from the environment so iOS AND
// Android both render Google Maps (never Apple Maps). The key lives in .env as
// EXPO_PUBLIC_GOOGLE_MAPS_API_KEY and is read at config-eval time.
const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

module.exports = () => ({
  name: 'FreePark',
  slug: 'freepark',
  version: '1.0.0',
  orientation: 'portrait',
  userInterfaceStyle: 'light',
  splash: {
    resizeMode: 'contain',
    backgroundColor: '#3B82F6',
  },
  ios: {
    supportsTablet: true,
    bundleIdentifier: 'com.freepark.app',
    config: {
      googleMapsApiKey: GOOGLE_MAPS_API_KEY,
    },
  },
  android: {
    adaptiveIcon: {
      backgroundColor: '#3B82F6',
    },
    package: 'com.freepark.app',
    config: {
      googleMaps: { apiKey: GOOGLE_MAPS_API_KEY },
    },
  },
  web: {
    bundler: 'metro',
    favicon: './assets/favicon.png',
  },
});
