// Dynamic Expo config: extends the static app.json and injects the native
// Google Maps SDK keys from the environment so iOS AND Android both render
// Google Maps (never Apple Maps). The key lives in .env as
// EXPO_PUBLIC_GOOGLE_MAPS_API_KEY and is read at config-eval time.
const appJson = require('./app.json');

const GOOGLE_MAPS_API_KEY = process.env.EXPO_PUBLIC_GOOGLE_MAPS_API_KEY ?? '';

module.exports = () => {
  const base = appJson.expo;
  return {
    ...base,
    ios: {
      ...base.ios,
      config: {
        ...(base.ios?.config ?? {}),
        googleMapsApiKey: GOOGLE_MAPS_API_KEY,
      },
    },
    android: {
      ...base.android,
      config: {
        ...(base.android?.config ?? {}),
        googleMaps: { apiKey: GOOGLE_MAPS_API_KEY },
      },
    },
  };
};
