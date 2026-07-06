/**
 * Jest config for the PURE navigation/cache/geo/theme logic (no React Native /
 * Expo). These modules are deliberately free of RN imports so they run under a
 * plain ts-jest + node environment — fast, and no native-module mocking or
 * fragile RN babel transform required. Type-checking is handled by
 * `tsc --noEmit`.
 *
 * NOTE: a jest-expo + React Native Testing Library "ui" project was trialled to
 * render markers/overlays, and worked briefly, but the jest-expo babel
 * transform of react-native's Flow-typed jest files (react-native/jest/mock.js)
 * is brittle against the exact React 19.1.0 / Expo SDK 54.0.33 patch set — it
 * failed to strip Flow after a dependency reconcile. Rather than pin a fragile
 * transform chain, the component-level guarantees are covered here by pure
 * assertions on the extracted style tokens + a source-scan, and by the static
 * overlay/key/camera audit documented in the PR.
 */
/** @type {import('jest').Config} */
module.exports = {
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  moduleFileExtensions: ['ts', 'tsx', 'js', 'json'],
  testMatch: ['**/*.test.ts'],
  transform: {
    // isolatedModules is already enabled in tsconfig.json.
    '^.+\\.tsx?$': ['ts-jest', {}],
  },
};
