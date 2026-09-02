// r3-cache: the on-site pre-fetch daemon.
//
//   npx tsx daemon/main.ts        (dev)
//   r3-cache --install            (register auto-start, once)
//   r3-cache                      (run in this console)
//
// Zero-config by contract: run it, then claim it from the app on the same
// network and approve whatever else asks to join. Everything else —
// storage location, disk budget,
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
import { createAdmin } from './admin'
import { createPairing, deviceIdForToken, isApproved } from './pairing'
import { createRoomsHop } from './roomsHop'
import { createDaemonServer } from './server'
import { createItemStore } from './storage'
import { createTitleCrawler } from './titleCrawler'
import { createTitleStore } from './titles'
import { createUpdater } from './updater'

// Stamped at build time by scripts/build-daemon (esbuild --define), so a
// released daemon carries the same version as the app release it shipped
// with — which is what lets the app judge protocol compatibility from
// /api/ping, and what the updater compares against the release feed. The
// fallback marks a from-source dev run.
const VERSION = process.env.R3_CACHE_VERSION || '0.0.0-dev'
const EVICTION_INTERVAL_MS = 60 * 60 * 1000
/** The household catalog re-crawl cadence. Six hours matches the app's own
 *  standing crawl — the point is that only THIS box pays it. */
const TITLE_CRAWL_INTERVAL_MS = 6 * 60 * 60 * 1000
/** First crawl after boot waits this long, so a restart storm (updates,
 *  crash loops) does not hammer the upstream catalogs. */
const TITLE_CRAWL_BOOT_DELAY_MS = 30_000

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
  const activity = createActivityTracker(config.dataDir)
  const storage = createItemStore(
    config.dataDir,
    {
      idleTtlMs: config.idleTtlDays * dayMs,
      hardMaxMs: config.hardMaxDays * dayMs,
      budgetBytes: config.diskBudgetBytes,
      tombstoneMs: config.tombstoneDays * dayMs
    },
    // Neither eviction path may delete a file somebody has a stream open
    // against. The tracker is built just above for this reason.
    { isStreaming: (infoHash) => activity.isStreaming(infoHash) }
  )
  const pairing = createPairing(config.dataDir)
  const admin = createAdmin(config.dataDir)
  const credentials = createCredentials(config.dataDir)
  const jobs = createJobStore(config.dataDir)
  const titles = createTitleStore(config.dataDir)
  await Promise.all([
    pairing.load(),
    admin.load(),
    credentials.load(),
    jobs.load(),
    activity.load(),
    titles.load()
  ])

  // Stamp entitlement onto anything written before the fields existed.
  // Runs once — migrateEntitlement skips items that already carry a
  // visibility — and says so plainly, because the effect is user-visible:
  // items that every paired device could previously see are now private to
  // whoever fetched them, and someone will want to know why a housemate's
  // film vanished from their list.
  const migrated = await storage.migrateEntitlement()
  if (migrated > 0) {
    log(
      `entitlement: ${migrated} existing item(s) marked. Items with a known ` +
        'owner are now private to that device; items with no identifiable ' +
        'owner were left shared. Re-share from the app if needed.'
    )
  }

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

  const fetcher = createFetcher({
    jobs,
    storage,
    credentials,
    dataDir: config.dataDir,
    log,
    // The same allocation the eviction pass enforces. Read through one
    // function so a fetch cannot be admitted against a rule the sweep will
    // then apply differently an hour later.
    quotaFor: (deviceId) => deviceQuotas().get(deviceId) ?? null
  })
  const updater = createUpdater({
    dataDir: config.dataDir,
    currentVersion: runningVersion,
    channel: config.updateChannel,
    enabled: config.autoUpdate,
    activity,
    requestRestart: () => resolveOutcome('restart'),
    log
  })
  const titleCrawler = createTitleCrawler({ store: titles, log })
  const server = createDaemonServer({
    storage,
    jobs,
    pairing,
    admin,
    credentials,
    activity,
    updaterStatus: () => updater.status(),
    applyUpdateNow: () => updater.applyNow(),
    serverName: config.serverName,
    version: runningVersion,
    diskBudgetBytes: config.diskBudgetBytes,
    titles,
    titleCrawler
  })
  // Rooms use this box as their LAN hop: one relay connection per room
  // for the whole network, instead of one per device. Ciphertext only —
  // see roomsHop.ts's header for what this box can and cannot see.
  const roomsHop = createRoomsHop({
    isAuthorized: (token) => pairing.isAuthorized(token),
    log
  })
  server.on('upgrade', (req, socket, head) => {
    if (!roomsHop.handleUpgrade(req, socket, head)) {
      socket.destroy()
    }
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
  /**
   * Per-device allocations, rebuilt on each read so an admin's change takes
   * effect on the next eviction or fetch rather than on the next restart.
   *
   * A device with no quota of its own falls back to the admin's default
   * share of the budget, and if there is no default either it is simply
   * absent from the map -- bounded only by the whole disk, exactly as every
   * install behaved before quotas existed. That absence is the migration:
   * nothing changes until somebody sets a number.
   *
   * Items owned by a device that is no longer paired keep their owner id
   * and fall out of the map with it, so they are bounded by the disk budget
   * alone. Reclaiming a revoked device's files is a deletion decision that
   * deserves its own design, not a side effect of this.
   */
  const deviceQuotas = (): Map<string, number> => {
    const quotas = new Map<string, number>()
    const percent = admin.defaultQuotaPercent()
    const fallback = percent > 0 ? Math.floor((config.diskBudgetBytes * percent) / 100) : null
    for (const device of pairing.listDevices()) {
      if (!isApproved(device)) continue
      const quota = device.quotaBytes ?? fallback
      if (typeof quota !== 'number') continue
      quotas.set(deviceIdForToken(device.token), quota)
    }
    return quotas
  }

  // space bounds what this shared machine can afford.
  const evict = async (): Promise<void> => {
    let freeBytes: number | null = null
    try {
      const stat = await fsp.statfs(config.dataDir)
      freeBytes = stat.bavail * stat.bsize
    } catch {
      // statfs unavailable — the configured budget alone still applies.
    }
    const plan = await storage.runEviction(Date.now(), freeBytes, deviceQuotas())
    for (const [infoHash, reason] of plan) log(`evicted  ${infoHash.slice(0, 8)}… (${reason})`)
  }
  await evict()
  const evictionTimer = setInterval(() => void evict(), EVICTION_INTERVAL_MS)
  evictionTimer.unref?.()

  // The household title crawl: shortly after boot (immediately useful on a
  // fresh install, gentle on a restart storm), then on the same six-hourly
  // cadence the app itself used to pay per device. unref'd — a crawl must
  // never hold the process open past a stop.
  const titleBootTimer = setTimeout(
    () => void titleCrawler.runScheduled(),
    TITLE_CRAWL_BOOT_DELAY_MS
  )
  titleBootTimer.unref?.()
  const titleCrawlTimer = setInterval(
    () => void titleCrawler.runScheduled(),
    TITLE_CRAWL_INTERVAL_MS
  )
  titleCrawlTimer.unref?.()

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
    // R3_CACHE_NO_MDNS is for harnesses and scratch instances. An
    // unclaimed daemon that announces itself is claimable by whoever
    // finds it, and running a test should not put a claimable cache
    // server on somebody's home network. stop() is safe either way.
    if (process.env.R3_CACHE_NO_MDNS !== '1') mdns.start()
    updater.start()

    // Genuinely up: listening, stores loaded, first eviction done. This
    // stamps the launcher's tripwire healthy — but does NOT clear it, so a
    // version that comes up and then dies quickly is still rolled back.
    api.markHealthy()

    // No pairing code any more — devices ask to join and the administrator
    // approves them from the app. The banner says what the box IS, which is
    // what somebody at this console still needs: which server, which port,
    // which disk budget.
    console.log('')
    console.log('  ┌──────────────────────────────────────────────┐')
    console.log(`  │  r3-cache ${runningVersion} — "${config.serverName}"`.padEnd(49) + '│')
    console.log(`  │  port ${config.port}`.padEnd(49) + '│')
    console.log(
      `  │  budget ${(config.diskBudgetBytes / 1024 ** 3).toFixed(0)} GB · idle ${config.idleTtlDays}d · max ${config.hardMaxDays}d`.padEnd(
        49
      ) + '│'
    )
    console.log('  │                                              │')
    console.log('  │  Devices ask to join from the app.           │')
    console.log('  │  The administrator approves them there.      │')
    console.log('  └──────────────────────────────────────────────┘')
    // Below the box, not inside it: this is the path somebody needs to
    // find r3-cache.json, and a box wide enough for every path on every
    // platform does not exist. It used to be truncated mid-directory,
    // which is the one way of printing it that helps nobody.
    console.log(`     data ${config.dataDir}`)
    console.log('')

    // An unclaimed server says so, repeatedly and loudly.
    //
    // The exposure this covers is real: the daemon announces itself over
    // mDNS and is built to run at boot on a box nobody looks at, so an
    // unclaimed one sitting for a week is claimable by whoever finds it.
    // Saying it once at startup would scroll away in a log nobody reads;
    // repeating it is what makes an operator notice they never finished
    // setting the thing up.
    if (admin.isUnclaimed()) {
      const warn = (): void => {
        if (!admin.isUnclaimed()) return
        log('UNCLAIMED — no administrator yet. Open the app on this network and claim it.')
      }
      warn()
      const timer = setInterval(warn, 5 * 60_000)
      // Never hold the process open for a warning.
      timer.unref?.()
    }

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
    clearTimeout(titleBootTimer)
    clearInterval(titleCrawlTimer)
    updater.stop()
    mdns.stop()
    roomsHop.stop()

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

  // Console recovery. The console stays the root of trust — not because
  // anyone should have to use it, but because on a box you physically
  // control it is the one authority that cannot be taken remotely. This is
  // the way back from a lost admin device, and the reason claiming can be
  // bounded without stranding anybody.
  if (argv.includes('--claim-admin')) {
    const admin = createAdmin(config.dataDir)
    await admin.load()
    await admin.reopen()
    log('claiming reopened — the next device to claim from the app becomes administrator')
    return
  }

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
