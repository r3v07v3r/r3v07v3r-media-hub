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
//
// The other half is scripts/ensure-electron.mjs, which `npm run dev` and
// `npm start` run first: electron-vite reads node_modules/electron/path.txt
// itself and stops when it is missing, which is what a fresh install leaves
// from Electron 42 on. It is driven here against a fake package directory
// whose install.js only counts its runs, never against the real one.
// Run with: npx tsx tests/electronBinary.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import Module from 'node:module'
import os from 'node:os'
import path from 'node:path'

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

  console.log('\nensure-electron before dev and start')
  const { ensureElectron } = await import('../scripts/ensure-electron.mjs')

  /** A package directory whose install.js records each run and writes path.txt, as the real one does. */
  function fakePackage(installBody?: string): { dir: string; runs: () => number } {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-electron-'))
    const log = path.join(dir, 'runs.log')
    fs.writeFileSync(
      path.join(dir, 'install.js'),
      installBody ??
        `const fs = require('fs'), path = require('path')
fs.appendFileSync(${JSON.stringify(log)}, 'run\\n')
fs.writeFileSync(path.join(__dirname, 'path.txt'), 'electron')`
    )
    const runs = (): number =>
      fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).length : 0
    return { dir, runs }
  }

  await check('with no path.txt it runs install.js once; with path.txt it does nothing', () => {
    const fake = fakePackage()
    assert.equal(ensureElectron(fake.dir, {}), true)
    assert.equal(fake.runs(), 1)
    assert.ok(fs.existsSync(path.join(fake.dir, 'path.txt')))
    assert.equal(ensureElectron(fake.dir, {}), false)
    assert.equal(fake.runs(), 1, 'a second start must not install again')
  })

  await check('ELECTRON_EXEC_PATH, electron-vite’s own override, leaves nothing to fetch', () => {
    const fake = fakePackage()
    assert.equal(ensureElectron(fake.dir, { ELECTRON_EXEC_PATH: '/opt/electron/electron' }), false)
    assert.equal(fake.runs(), 0)
  })

  await check(
    'a failed install stops dev or start with the reason, not later in electron-vite',
    () => {
      const fake = fakePackage('process.exit(3)')
      assert.throws(() => ensureElectron(fake.dir, {}), /install\.js failed \(3\)/)
    }
  )

  await check('dev and start both run it first', () => {
    const { scripts } = JSON.parse(
      fs.readFileSync(path.join(import.meta.dirname, '..', 'package.json'), 'utf8')
    ) as { scripts: Record<string, string> }
    assert.equal(scripts.predev, 'node scripts/ensure-electron.mjs')
    assert.equal(scripts.prestart, 'node scripts/ensure-electron.mjs')
  })

  console.log(`\n${pass} passed`)
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
