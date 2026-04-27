const path = require('path');
const { getDefaultConfig } = require('expo/metro-config');
const { withNativeWind } = require('nativewind/metro');

// Apply NativeWind FIRST so its CSS transformer is registered before we add
// our own resolver on top.
const config = withNativeWind(getDefaultConfig(__dirname), {
  input: './global.css',
});

// Capture whatever resolver NativeWind set (may be undefined).
const nwResolve = config.resolver?.resolveRequest;

config.resolver.resolveRequest = (context, moduleName, platform) => {
  // Normalise Windows backslash paths so string matching works on all hosts.
  const mod = moduleName.replace(/\\/g, '/');

  // ── Web-only fixes ─────────────────────────────────────────────────────────
  if (platform === 'web') {
    // legacySendAccessibilityEvent exists only as .ios.js / .android.js in
    // RN 0.74 – there is no web version, so stub it out.
    if (mod.includes('legacySendAccessibilityEvent')) {
      return {
        type: 'sourceFile',
        filePath: path.resolve(__dirname, 'stubs', 'empty.js'),
      };
    }
  }

  // ── Native-only fixes ──────────────────────────────────────────────────────
  // react-native-web vendor files contain relative `../Utilities/Platform`
  // imports that Metro cannot resolve correctly on native platforms.
  if (mod === '../Utilities/Platform' && platform !== 'web') {
    const ext = platform === 'android' ? 'android' : 'ios';
    return {
      type: 'sourceFile',
      filePath: path.resolve(
        __dirname,
        `node_modules/react-native/Libraries/Utilities/Platform.${ext}.js`,
      ),
    };
  }

  // ── Delegate ───────────────────────────────────────────────────────────────
  return nwResolve
    ? nwResolve(context, moduleName, platform)
    : context.resolveRequest(context, moduleName, platform);
};

module.exports = config;
