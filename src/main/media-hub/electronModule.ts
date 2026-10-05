// Electron for the modules that resolve it at call time rather than import it
// at load time: logger.ts, settingsStore.ts, streamCache.ts and
// watchProviders.ts. Each explains why it is lazy (the unit tests import them
// under plain Node); this file is about what "lazy" may not do there.
//
// Up to Electron 41, `require('electron')` outside Electron answered at once:
// a path string, or a throw when the binary had never been fetched, which is
// what CI's `npm ci --ignore-scripts` leaves. The callers catch that and take
// their "not inside Electron" fallback. From Electron 42 the package has no
// postinstall, and its index.js downloads the ~100 MB binary and loads a
// native zip extractor the first time anything requires it with no binary
// present. The same lazy call would then start that download from inside a
// unit test. So this checks first, and throws the error the callers already
// expect without touching the package.
//
// Two runtimes get the real module. Electron itself, where
// process.versions.electron is set. And the headless backend for the phone,
// TV and server, which is plain Node: scripts/build-headless.mjs aliases
// 'electron' to src/headless/electronShim and defines R3_ELECTRON_SHIM as '1'
// at build time, so the check below is the constant `false` in that bundle.
// Nothing sets it under tsx, where the alias does not exist and
// `require('electron')` would reach the real package.

/** The Electron module; throws when the caller is not running inside Electron or the shim. */
export function electronModule(): typeof import('electron') {
  if (!process.versions.electron && process.env.R3_ELECTRON_SHIM !== '1') {
    throw new Error('Not running inside Electron.')
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  return require('electron')
}
