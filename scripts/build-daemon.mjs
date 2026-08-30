// Builds the r3-cache daemon for distribution.
//
//   node scripts/build-daemon.mjs                  bundle only (r3-cache.cjs)
//   node scripts/build-daemon.mjs --sea            + a self-contained
//                                                  executable for THIS OS
//   R3_CACHE_VERSION=1.0.84 node scripts/...       stamp a release version
//
// The bundle (~80 KB) runs on any Node >= 20. The SEA build (Node's
// single-executable application support) embeds the bundle inside a copy
// of the running Node binary, so the result needs nothing installed at
// all — that is the file a household member double-clicks. SEA is built
// per-OS (an executable embeds its platform's node), which is why CI runs
// this on a Windows and a Linux runner rather than cross-compiling.
//
// Everything here goes through the esbuild and postject JS APIs rather
// than spawning their CLIs. That is not tidiness: an adversarial review
// found the CLI form silently produced BROKEN LINUX BUILDS. The version
// was passed as --define:...='"1.2.3"', shell-quoted for the Windows
// shell:true path; on Linux (shell:false) execFileSync passes argv
// verbatim, so esbuild received the single quotes literally and baked
// VERSION = '"1.2.3"'. parseVersion rejects that, so every CI-built Linux
// daemon could never recognise an update — the exact platform the daemon
// actually runs on. Using the APIs removes the shell, the quoting, and
// the Windows cmd.exe argument-concatenation hazard in one move.

import esbuild from 'esbuild'
import { inject } from 'postject'
import { execFileSync } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const outDir = path.join(root, 'dist-daemon')
const version = process.env.R3_CACHE_VERSION || '0.0.0-dev'
const wantSea = process.argv.includes('--sea')

fs.mkdirSync(outDir, { recursive: true })

/** Checksums ride along as release assets. The self-updater REQUIRES the
 *  bundle's one: an update it cannot verify is an update it will not
 *  install (see daemon/updater.ts). */
function writeChecksum(filePath) {
  const digest = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex')
  fs.writeFileSync(`${filePath}.sha256`, `${digest}  ${path.basename(filePath)}\n`)
  return digest
}

// --- 1. bundle -------------------------------------------------------------
const bundlePath = path.join(outDir, 'r3-cache.cjs')
esbuild.buildSync({
  entryPoints: [path.join(root, 'daemon', 'main.ts')],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: bundlePath,
  // ws probes for these optional native accelerators inside try/catch;
  // left unresolved they would fail the bundle, marked external they
  // fail the probe at runtime and ws falls back to its JS paths.
  external: ['bufferutil', 'utf-8-validate'],
  // JSON.stringify, not hand-written quotes: the value must reach esbuild
  // as a JSON expression, and nothing in between may reinterpret it.
  define: { 'process.env.R3_CACHE_VERSION': JSON.stringify(version) }
})
writeChecksum(bundlePath)
console.log(`[build-daemon] bundle ${bundlePath} (version ${version})`)

// The stamp is what the updater compares against the release feed, so a
// build that mis-stamps is a daemon that can never update. Cheap to
// check, catastrophic to get wrong — so check it, every build.
const stamped = fs.readFileSync(bundlePath, 'utf8')
if (!stamped.includes(`VERSION = ${JSON.stringify(version)}`)) {
  console.error(`[build-daemon] FATAL: version stamp missing or malformed for ${version}`)
  process.exit(1)
}

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

// process.execPath is an absolute path to a real binary, so no shell.
execFileSync(process.execPath, ['--experimental-sea-config', seaConfigPath], {
  cwd: root,
  stdio: 'inherit'
})

// A copy of the very Node running this script becomes the carrier.
fs.copyFileSync(process.execPath, exePath)

// postject's API, not its CLI: same reasoning as esbuild above.
await inject(exePath, 'NODE_SEA_BLOB', fs.readFileSync(blobPath), {
  sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  machoSegmentName: process.platform === 'darwin' ? 'NODE_SEA' : undefined
})

fs.rmSync(seaConfigPath, { force: true })
fs.rmSync(blobPath, { force: true })

// The executable must actually START. CI publishes whatever this script
// produces, and the one failure mode rollback provably cannot rescue is a
// binary that never reaches the launcher at all — so prove it here.
const reported = execFileSync(exePath, ['--version'], { encoding: 'utf8' }).trim()
if (reported !== version) {
  console.error(`[build-daemon] FATAL: executable reports "${reported}", expected "${version}"`)
  process.exit(1)
}

writeChecksum(exePath)
const megabytes = (fs.statSync(exePath).size / 1024 ** 2).toFixed(0)
console.log(`[build-daemon] executable ${exePath} (${megabytes} MB, self-contained, --version ok)`)
