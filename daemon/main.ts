// r3-cache: the on-site pre-fetch daemon.
//
//   npx tsx daemon/main.ts        (dev)
//   r3-cache --install            (register auto-start, once)
//   r3-cache                      (run in this console)
//
// Zero-config by contract: run it, read the pairing code off this console,
// type it into the app. Everything else — storage location, disk budget,
// expiry, retries, and from now on UPDATES — has a default and maintains
// itself. An optional r3-cache.json beside the data directory overrides;
// see config.ts.
//
// This file is BOTH halves of the self-update design (see launcher.ts):
// executed directly it runs the launcher, which picks the newest healthy
// staged version — or the payload compiled into this very file, the
// fallback that can never be deleted. Required by a launcher, it exports
// that payload as run(). One artifact serves fresh installs and updates.

import fsp from 'node:fs/promises'

import { createActivityTracker } from './activity'
import { loadConfig } from './config'
import { createCredentials } from './credentials'
import { createFetcher } from './fetcher'
import { installAutoStart, uninstallAutoStart } from './install'
import { createJobStore } from './jobs'
import { launch, type PayloadApi } from './launcher'
import { createMdnsAnnouncer } from './mdns'
import { createPairing } from './pairing'
import { createDaemonServer } from './server'
import { createItemStore } from './storage'
import { createUpdater } from './updater'

// Stamped at build time by scripts/build-daemon (esbuild --define), so a
// released daemon carries the same version as the app release it shipped
// with — which is what lets the app judge protocol compatibility from
// /api/ping, and what the updater compares against the release feed. The
// fallback marks a from-source dev run.
const VERSION = process.env.R3_CACHE_VERSION || '0.0.0-dev'
const EVICTION_INTERVAL_MS = 60 * 60 * 1000

function log(message: string): void {
  console.log(`[r3-cache] ${new Date().toISOString()} ${message}`)
}

/**
 * The payload: everything the daemon IS, from boot to the decision to
 * stop. Resolves 'exit' on SIGINT/SIGTERM, and 'restart' when the updater
 * has staged a newer version and nobody is watching — the launcher then
 * loops and boots that version. Every resource acquired here is released
 * on the way out, because on 'restart' THIS PROCESS keeps living and the
 * next payload needs the port.
 */
export async function run(api: PayloadApi): Promise<'restart' | 'exit'> {
  const config = loadConfig()
  const runningVersion = api.runningVersion === 'builtin' ? VERSION : api.runningVersion
  // 0700: this directory will hold pairing tokens and, if people opt in,
  // TorBox credentials. On Windows the mode is ignored; there the profile
  // directory ACL is the boundary.
  await fsp.mkdir(config.dataDir, { recursive: true, mode: 0o700 })

  const dayMs = 24 * 60 * 60 * 1000
  const storage = createItemStore(config.dataDir, {
    idleTtlMs: config.idleTtlDays * dayMs,
    hardMaxMs: config.hardMaxDays * dayMs,
    budgetBytes: config.diskBudgetBytes,
    tombstoneMs: config.tombstoneDays * dayMs
  })
  const pairing = createPairing(config.dataDir)
  const credentials = createCredentials(config.dataDir)
  const jobs = createJobStore(config.dataDir)
  const activity = createActivityTracker(config.dataDir)
  await Promise.all([pairing.load(), credentials.load(), jobs.load(), activity.load()])

  let resolveOutcome!: (outcome: 'restart' | 'exit') => void
  const outcome = new Promise<'restart' | 'exit'>((resolve) => {
    resolveOutcome = resolve
  })

  // Installed BEFORE the slow startup work, not after it. The startup
  // eviction is deliberately a full pass over the cache, which on a large
  // one is seconds to minutes; with default signal disposition a stop in
  // that window killed the process outright and left the launcher's
  // tripwire set, so two ordinary logoffs could blacklist a version that
  // had never actually failed.
  let stopping = false
  const onSignal = (): void => {
    stopping = true
    resolveOutcome('exit')
  }
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)
  const releaseSignals = (): void => {
    process.off('SIGINT', onSignal)
    process.off('SIGTERM', onSignal)
  }

  const fetcher = createFetcher({ jobs, storage, credentials, dataDir: config.dataDir, log })
  const updater = createUpdater({
    dataDir: config.dataDir,
    currentVersion: runningVersion,
    channel: config.updateChannel,
    enabled: config.autoUpdate,
    activity,
    requestRestart: () => resolveOutcome('restart'),
    log
  })
  const server = createDaemonServer({
    storage,
    jobs,
    pairing,
    credentials,
    activity,
    updaterStatus: () => updater.status(),
    serverName: config.serverName,
    version: runningVersion,
    diskBudgetBytes: config.diskBudgetBytes
  })
  const mdns = createMdnsAnnouncer({
    serverName: config.serverName,
    port: config.port,
    version: runningVersion,
    log
  })

  // Expiry runs at startup (a daemon that was off for a month has a month
  // of overdue evictions) and hourly after. Real free space is measured
  // fresh each pass — the budget bounds the cache's own use, but free
  // space bounds what this shared machine can afford.
  const evict = async (): Promise<void> => {
    let freeBytes: number | null = null
    try {
      const stat = await fsp.statfs(config.dataDir)
      freeBytes = stat.bavail * stat.bsize
    } catch {
      // statfs unavailable — the configured budget alone still applies.
    }
    const plan = await storage.runEviction(Date.now(), freeBytes)
    for (const [infoHash, reason] of plan) log(`evicted  ${infoHash.slice(0, 8)}… (${reason})`)
  }
  await evict()
  const evictionTimer = setInterval(() => void evict(), EVICTION_INTERVAL_MS)
  evictionTimer.unref?.()

  // Every resource from here on is released by the finally below. Without
  // it, one throw after listen() left the port bound; the launcher then
  // retried, hit EADDRINUSE, counted THAT as this version failing, and
  // blacklisted every staged version in seconds.
  let listening = false
  try {
    await new Promise<void>((resolve, reject) => {
      const onListenError = (error: Error): void => reject(error)
      server.once('error', onListenError)
      server.listen(config.port, '0.0.0.0', () => {
        // Removed on success so a LATER server error is not silently
        // swallowed by a listener that only meant to guard startup.
        server.off('error', onListenError)
        server.on('error', (error) => log(`server error: ${error.message}`))
        resolve()
      })
    })
    listening = true
    fetcher.start()
    mdns.start()
    updater.start()

    // Genuinely up: listening, stores loaded, first eviction done. This
    // stamps the launcher's tripwire healthy — but does NOT clear it, so a
    // version that comes up and then dies quickly is still rolled back.
    api.markHealthy()

    const banner = (code: string): void => {
      console.log('')
      console.log('  ┌──────────────────────────────────────────────┐')
      console.log(`  │  r3-cache ${runningVersion} — "${config.serverName}"`.padEnd(49) + '│')
      console.log(`  │  port ${config.port} · data ${config.dataDir}`.slice(0, 49).padEnd(49) + '│')
      console.log(
        `  │  budget ${(config.diskBudgetBytes / 1024 ** 3).toFixed(0)} GB · idle ${config.idleTtlDays}d · max ${config.hardMaxDays}d`.padEnd(
          49
        ) + '│'
      )
      console.log('  │                                              │')
      console.log(`  │  PAIRING CODE:  ${code}                       │`)
      console.log('  │  Enter this in the app to connect.           │')
      console.log('  └──────────────────────────────────────────────┘')
      console.log('')
    }
    banner(pairing.currentCode())
    pairing.onCodeChange(banner)

    const result = await outcome
    log(result === 'restart' ? 'stopping for update' : 'shutting down')
    return result
  } finally {
    // Runs on EVERY exit from the block above — clean stop, update
    // restart, or a throw. On 'restart' this process keeps living and the
    // next payload must be able to bind the port, so nothing here may be
    // skipped.
    releaseSignals()
    clearInterval(evictionTimer)
    updater.stop()
    mdns.stop()

    // The fetcher is stopped BEFORE the listening socket closes. It owns
    // no client connections, and closing the port first meant the daemon
    // was unreachable for the whole of a mid-flight download's teardown —
    // dead air during what is supposed to be an invisible update.
    await fetcher.stop().catch((error) => log(`fetcher stop: ${(error as Error).message}`))

    if (listening) {
      server.closeAllConnections?.()
      await new Promise<void>((resolve) => server.close(() => resolve()))
    }
    if (stopping) {
      // A signal decided this; make sure nothing keeps the process alive.
      activity.snapshot()
    }
  }
}

/** True when this file is the process entrypoint (dev tsx run, bundled
 *  .cjs run, or SEA executable) rather than a payload require()d by a
 *  launcher. */
function isMainEntry(): boolean {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyModule = typeof module !== 'undefined' ? (module as any) : undefined
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const anyRequire = typeof require !== 'undefined' ? (require as any) : undefined
  if (anyModule && anyRequire) return anyRequire.main === anyModule
  // No CJS module context (SEA embedded script) — this is the entrypoint.
  return true
}

async function entry(): Promise<void> {
  const argv = process.argv.slice(2)
  if (argv.includes('--version')) {
    console.log(VERSION)
    return
  }
  if (argv.includes('--install')) {
    await installAutoStart(log)
    return
  }
  if (argv.includes('--uninstall')) {
    await uninstallAutoStart(log)
    return
  }

  const config = loadConfig()
  await launch({
    dataDir: config.dataDir,
    launcherVersion: VERSION,
    builtinRun: run,
    log
  })
  process.exit(0)
}

if (isMainEntry()) {
  void entry().catch((error) => {
    console.error(`[r3-cache] failed to start: ${(error as Error).message}`)
    process.exit(1)
  })
}
