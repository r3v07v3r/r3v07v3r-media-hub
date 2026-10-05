// What the unit tests may not do with the `electron` package: load it.
//
// From Electron 42 the package has no postinstall, and its index.js downloads
// the ~100 MB binary the first time anything requires it with no binary
// present. The service modules that resolve Electron lazily (logger.ts,
// settingsStore.ts, streamCache.ts, watchProviders.ts) used to require it and
// catch the throw; under the new package that require would be a download in
// the middle of a test run. electronModule.ts now checks first. This pins
// that the package is never asked for outside Electron, that each caller
// still takes its "not inside Electron" fallback, and that Electron itself
// and the headless bundle (which bakes R3_ELECTRON_SHIM in) still get through.
//
// `require('electron')` is intercepted for the whole file and answered with a
// stand-in, so a regression here fails an assertion rather than starting the
// download it is meant to prevent.
// Run with: npx tsx tests/electronBinary.test.ts

import assert from 'node:assert/strict'
import Module from 'node:module'

const requested: string[] = []
const standIn = { standIn: true }
const loader = Module as unknown as { _load: (request: string, ...rest: unknown[]) => unknown }
const realLoad = loader._load
loader._load = function (request: string, ...rest: unknown[]) {
  if (request === 'electron') {
    requested.push(request)
    return standIn
  }
  return realLoad.call(this, request, ...rest)
}

let pass = 0
async function check(name: string, fn: () => Promise<void> | void): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  // After the interceptor: these modules must not reach the real package even
  // if a future edit puts a require back at load time.
  const { electronModule } = await import('../src/main/media-hub/electronModule')
  const { readSettings } = await import('../src/main/media-hub/settingsStore')
  const { watchRegion } = await import('../src/main/media-hub/watchProviders')
  const { logError } = await import('../src/main/media-hub/logger')
  const { cacheRootDir } = await import('../src/main/media-hub/streamCache')

  assert.equal(process.versions.electron, undefined, 'this file must run under plain Node')
  delete process.env.R3_ELECTRON_SHIM

  console.log('electron outside Electron')

  await check('outside Electron the guard throws without asking for the package', () => {
    requested.length = 0
    assert.throws(() => electronModule(), /Not running inside Electron/)
    assert.deepEqual(requested, [])
  })

  await check('every lazy caller takes its fallback without asking for the package', () => {
    requested.length = 0
    assert.deepEqual(readSettings(), {}, 'settings with no Electron to find a folder: empty')
    assert.equal(watchRegion(), 'US', 'region with no locale to read: the default')
    assert.doesNotThrow(() => logError('electronBinary.test', new Error('a line nobody writes')))
    assert.throws(() => cacheRootDir(), /Not running inside Electron/)
    assert.deepEqual(requested, [])
  })

  await check('inside Electron the guard returns the real module', () => {
    requested.length = 0
    Object.defineProperty(process.versions, 'electron', { value: '44.5.1', configurable: true })
    try {
      assert.equal(electronModule(), standIn)
    } finally {
      delete (process.versions as Record<string, string | undefined>).electron
    }
    assert.deepEqual(requested, ['electron'])
  })

  await check('in the headless bundle the guard lets the stand-in through', () => {
    // scripts/build-headless.mjs defines this as '1' at build time, where
    // 'electron' is aliased to src/headless/electronShim.
    requested.length = 0
    process.env.R3_ELECTRON_SHIM = '1'
    try {
      assert.equal(electronModule(), standIn)
    } finally {
      delete process.env.R3_ELECTRON_SHIM
    }
    assert.deepEqual(requested, ['electron'])
  })

  console.log(`\n${pass} passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
