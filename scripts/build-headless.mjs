// Bundles the service layer to run WITHOUT Electron: dist-headless/backend.cjs,
// one file, started with plain `node`. This is the backend of the TV and phone
// apps, and the same thing as a server on a box with no display.
//
// The whole trick is three aliases. `electron` resolves to a stand-in
// (src/headless/electronShim) that gives the service layer a real ipcMain, a
// real safeStorage and a push path, and refuses the rest; the updater and the
// Win32 FFI resolve to inert stubs. Not one line under src/main knows.
//
// esbuild is also the checklist: a name imported from 'electron' that the
// stand-in does not export fails this build ("No matching export"), so the
// stand-in cannot silently fall behind the code it stands in for.
//
// Through the esbuild JS API rather than its CLI, for the reason
// build-daemon.mjs gives at length: no shell, no quoting, one behaviour on
// every platform.

import esbuild from 'esbuild'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'dist-headless')
const outfile = path.join(outDir, 'backend.cjs')
const { version } = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))

fs.mkdirSync(outDir, { recursive: true })

const result = esbuild.buildSync({
  entryPoints: [path.join(root, 'src', 'headless', 'main.ts')],
  bundle: true,
  platform: 'node',
  // node:sqlite and the global WebSocket are what set the floor.
  target: 'node22',
  format: 'cjs',
  outfile,
  metafile: true,
  logLevel: 'warning',
  alias: {
    electron: path.join(root, 'src', 'headless', 'electronShim', 'index.ts'),
    'electron-updater': path.join(root, 'src', 'headless', 'stubs', 'electronUpdater.ts'),
    koffi: path.join(root, 'src', 'headless', 'stubs', 'koffi.ts')
  },
  external: [
    // ws probes for these optional native accelerators inside try/catch; left
    // unresolved they would fail the bundle, marked external they fail the
    // probe at runtime and ws falls back to its JS paths.
    'bufferutil',
    'utf-8-validate',
    // Router port-mapping for hosting a watch party directly. Reached only
    // through a dynamic import inside upnp.ts, and only on a host that can
    // map ports at all.
    '@achingbrain/nat-port-mapper',
    'default-gateway'
  ],
  // JSON.stringify, not hand-written quotes: the value must reach esbuild as
  // a JSON expression, and nothing in between may reinterpret it.
  define: { 'process.env.R3_APP_VERSION': JSON.stringify(version) }
})

// Nothing of Electron's may have come along. If the real package got in, an
// alias failed to apply and the bundle would die at startup looking for a
// binary that is not there — far better to find out here.
// (esbuild reports every input with forward slashes, on every platform.)
const inputs = Object.keys(result.metafile.inputs)
const leaked = inputs.filter((file) =>
  /node_modules\/(electron|electron-updater|koffi)\//.test(file)
)
if (leaked.length) {
  console.error('[build-headless] FATAL: desktop-only packages reached the bundle:')
  for (const file of leaked) console.error(`  ${file}`)
  process.exit(1)
}

const kb = Math.round(fs.statSync(outfile).size / 1024)
console.log(
  `[build-headless] ${path.relative(root, outfile)} — ${kb} kB, ${inputs.length} modules, version ${version}`
)
