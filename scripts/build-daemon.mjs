// Builds the r3-cache daemon for distribution.
//
//   node scripts/build-daemon.mjs                  bundle only (r3-cache.cjs)
//   node scripts/build-daemon.mjs --sea            + a self-contained
//                                                  executable for THIS OS
//   R3_CACHE_VERSION=1.0.84 node scripts/...       stamp a release version
//
// The bundle (~60 KB) runs on any Node >= 20. The SEA build (Node's
// single-executable application support) embeds the bundle inside a copy
// of the running Node binary, so the result needs nothing installed at
// all — that is the file a household member double-clicks. SEA is built
// per-OS (an executable embeds its platform's node), which is why CI runs
// this on a Windows and a Linux runner rather than cross-compiling.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'dist-daemon')
const version = process.env.R3_CACHE_VERSION || '0.0.0-dev'
const wantSea = process.argv.includes('--sea')

fs.mkdirSync(outDir, { recursive: true })

// --- 1. bundle -------------------------------------------------------------
const bundlePath = path.join(outDir, 'r3-cache.cjs')
execFileSync(
  process.platform === 'win32' ? 'npx.cmd' : 'npx',
  [
    'esbuild',
    'daemon/main.ts',
    '--bundle',
    '--platform=node',
    '--target=node20',
    // Baked in, not read at runtime: the executable must know what it is
    // even when copied to a machine with no environment set up.
    `--define:process.env.R3_CACHE_VERSION='"${version}"'`,
    `--outfile=${bundlePath}`
  ],
  { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' }
)
console.log(`[build-daemon] bundle ${bundlePath} (version ${version})`)

if (!wantSea) process.exit(0)

// --- 2. single executable for this platform --------------------------------
const isWindows = process.platform === 'win32'
const exeName = isWindows ? 'r3-cache-win-x64.exe' : `r3-cache-${process.platform}-x64`
const exePath = path.join(outDir, exeName)
const seaConfigPath = path.join(outDir, 'sea-config.json')
const blobPath = path.join(outDir, 'sea-prep.blob')

fs.writeFileSync(
  seaConfigPath,
  JSON.stringify({
    main: bundlePath,
    output: blobPath,
    // The bundle is plain CJS with no dynamic requires, so the snapshot
    // warning suppression keeps CI logs readable.
    disableExperimentalSEAWarning: true
  })
)

execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  cwd: root,
  stdio: 'inherit'
})

// A copy of the very Node running this script becomes the carrier.
fs.copyFileSync(process.execPath, exePath)

// postject writes the blob into the binary at the sentinel Node looks for.
execFileSync(
  isWindows ? 'npx.cmd' : 'npx',
  [
    'postject@1.0.0-alpha.6',
    exePath,
    'NODE_SEA_BLOB',
    blobPath,
    '--sentinel-fuse',
    'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2'
  ],
  { cwd: root, stdio: 'inherit', shell: isWindows }
)

fs.rmSync(seaConfigPath, { force: true })
fs.rmSync(blobPath, { force: true })

const megabytes = (fs.statSync(exePath).size / 1024 ** 2).toFixed(0)
console.log(`[build-daemon] executable ${exePath} (${megabytes} MB, self-contained)`)
