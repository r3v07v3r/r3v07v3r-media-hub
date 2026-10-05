// Fetches the Electron binary before `npm run dev` and `npm start` when it is
// missing (the predev and prestart scripts in package.json).
//
// electron-vite starts Electron by reading node_modules/electron/path.txt,
// which the electron package writes once its binary is in place, and stops
// with "Electron uninstall" when the file is absent. Up to Electron 41 the
// package's own postinstall downloaded the binary during `npm install`. From
// 42 there is no postinstall, and the package downloads on its first
// require('electron'), which electron-vite never makes, so a fresh install
// cannot start the app. `npm ci --ignore-scripts` leaves the same gap on any
// version. This runs the package's install.js, which checks the download
// against the checksums shipped inside the package, when path.txt is missing,
// and does nothing at all when it is there.
//
// ELECTRON_EXEC_PATH is electron-vite's own setting for a binary kept
// elsewhere; with it set there is nothing to fetch.

import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import process from 'node:process'

/**
 * Runs <electronDir>/install.js when <electronDir>/path.txt is missing.
 * Returns whether it ran; throws when the install fails.
 */
export function ensureElectron(electronDir, env = process.env) {
  if (env.ELECTRON_EXEC_PATH) return false
  if (fs.existsSync(path.join(electronDir, 'path.txt'))) return false
  console.log('[ensure-electron] No Electron binary yet; running node_modules/electron/install.js')
  const result = spawnSync(process.execPath, [path.join(electronDir, 'install.js')], {
    stdio: 'inherit',
    env
  })
  if (result.status !== 0) {
    throw new Error(
      `install.js failed (${result.error?.message ?? result.status ?? result.signal})`
    )
  }
  return true
}

function main() {
  // Resolved the way electron-vite resolves it. require.resolve finds the
  // file without running it, and running index.js is what downloads.
  const require = createRequire(import.meta.url)
  const electronDir = path.dirname(require.resolve('electron'))
  try {
    ensureElectron(electronDir)
  } catch (error) {
    console.error(`[ensure-electron] ${error.message}`)
    process.exit(1)
  }
}

if (process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]))) main()
