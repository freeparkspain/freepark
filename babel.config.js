module.exports = function (api) {
  api.cache(true);
  return {
    presets: [
      // jsxImportSource MUST be 'react-native-css-interop', not 'nativewind'.
      // nativewind/jsx-runtime does not exist in v4.2.3; the runtime lives in
      // react-native-css-interop/jsx-runtime (→ dist/runtime/jsx-runtime).
      ['babel-preset-expo', { jsxImportSource: 'react-native-css-interop' }],
    ],
    plugins: [
      // Wraps every JSX element with createInteropElement so className props
      // are resolved against the Tailwind style registry at runtime.
      // This replicates what nativewind/babel does, minus react-native-worklets
      // (that plugin is for Reanimated 4+ and is not installed here).
      require('react-native-css-interop/dist/babel-plugin').default,
      // Reanimated 3.x worklet transform — must be the last plugin.
      'react-native-reanimated/plugin',
    ],
  };
};
