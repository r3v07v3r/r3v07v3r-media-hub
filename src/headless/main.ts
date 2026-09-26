// The backend with no Electron around it. Everything under src/main runs here
// exactly as it does on the desktop — same handlers, same database, same
// background jobs — behind the `electron` stand-in (electronShim/) and reached
// over the bridge (bridge.ts) instead of a preload. This file is the part of
// src/main/index.ts that is about SERVICES; the part that is about windows has
// no equivalent and is simply absent.
//
// Configured entirely by the host that starts it:
//   R3_USER_DATA    where settings, the database and logs live   (required)
//   R3_SITE_DIR     the built renderer, npm run build:web         (required)
//   R3_BRIDGE_PORT  loopback port; omitted, the OS picks one
//   R3_MASTER_KEY   32 bytes, base64: the key settings are sealed with
//   R3_STOP_ON_STDIN_CLOSE=1   shut down when stdin closes (a host that owns us)

import path from 'node:path'

import { startBackend, stopBackend } from '../main/backend'
import { setActiveWindow } from '../main/media-hub/rendererBridge'
import { setPlatformCapabilities } from '../main/media-hub/platform'
import { startBackgroundJobs } from '../main/media-hub/backgroundJobs'
import { startBridge, type Bridge } from './bridge'
import { BrowserWindow } from './electronShim'

function required(name: string): string {
  const value = process.env[name]
  if (!value) {
    console.error(`[headless] ${name} is not set.`)
    process.exit(2)
  }
  return value
}

async function main(): Promise<void> {
  const userData = path.resolve(required('R3_USER_DATA'))
  const siteDir = path.resolve(required('R3_SITE_DIR'))

  // Before anything under src/main runs: several subsystems decide what to be
  // at the moment they are first touched.
  setPlatformCapabilities({ systemTelemetry: false })

  // Not windows — names for the two ends of the bridge the service layer
  // pushes to. See electronShim's BrowserWindow.
  const mainWindow = new BrowserWindow()
  const overlayWindow = new BrowserWindow()

  startBackend()
  setActiveWindow(mainWindow as never)

  const port = process.env.R3_BRIDGE_PORT ? Number(process.env.R3_BRIDGE_PORT) : 0
  const bridge: Bridge = await startBridge({
    siteDir,
    port,
    windows: { main: mainWindow, overlay: overlayWindow },
    sessionFile: path.join(userData, 'bridge-sessions.json')
  })

  // After the bridge is up, for the reason the desktop starts them after its
  // window: the app's own startup never competes with a job that is due.
  startBackgroundJobs()

  // One line a host can parse, and a person can click.
  console.log(
    `[headless] ready ${JSON.stringify({ origin: bridge.origin, launchUrl: bridge.launchUrl })}`
  )

  let stopping = false
  const stop = (reason: string): void => {
    if (stopping) return
    stopping = true
    console.log(`[headless] stopping (${reason})`)
    // The same teardown the desktop runs on before-quit (see backend.ts),
    // called directly so it has finished by the time the process goes.
    stopBackend()
    void bridge.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', () => stop('SIGINT'))
  process.on('SIGTERM', () => stop('SIGTERM'))
  // A host that OWNS this process (the Android shell) holds its stdin open and
  // closes it to say "you are done" — which also covers the host dying, since
  // the pipe closes with it and no orphan is left behind. Opt-in: a service
  // manager starts its children with stdin already at /dev/null, and must not
  // be read as having said so.
  if (process.env.R3_STOP_ON_STDIN_CLOSE === '1') {
    process.stdin.on('end', () => stop('stdin closed'))
    process.stdin.resume()
  }
}

main().catch((error) => {
  console.error('[headless] failed to start:', error)
  process.exit(1)
})
