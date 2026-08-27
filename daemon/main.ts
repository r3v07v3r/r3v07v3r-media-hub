// r3-cache: the on-site pre-fetch daemon.
//
//   npx tsx daemon/main.ts        (dev)
//   r3-cache                      (packaged executable)
//
// Zero-config by contract: run it, read the pairing code off this console,
// type it into the app. Everything else — storage location, disk budget,
// expiry, retries — has a default and maintains itself. An optional
// r3-cache.json beside the data directory overrides; see config.ts.

import fsp from 'node:fs/promises'

import { loadConfig } from './config'
import { createCredentials } from './credentials'
import { createFetcher } from './fetcher'
import { createJobStore } from './jobs'
import { createMdnsAnnouncer } from './mdns'
import { createPairing } from './pairing'
import { createDaemonServer } from './server'
import { createItemStore } from './storage'

const VERSION = '0.1.0'
const EVICTION_INTERVAL_MS = 60 * 60 * 1000

function log(message: string): void {
  console.log(`[r3-cache] ${new Date().toISOString()} ${message}`)
}

async function main(): Promise<void> {
  const config = loadConfig()
  // 0700: this directory will hold pairing tokens and, if the person opts
  // in, a TorBox credential. On Windows the mode is ignored; there the
  // profile directory ACL is the boundary.
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
  await Promise.all([pairing.load(), credentials.load(), jobs.load()])

  const fetcher = createFetcher({ jobs, storage, credentials, dataDir: config.dataDir, log })
  const server = createDaemonServer({
    storage,
    jobs,
    pairing,
    credentials,
    serverName: config.serverName,
    version: VERSION,
    diskBudgetBytes: config.diskBudgetBytes
  })
  const mdns = createMdnsAnnouncer({
    serverName: config.serverName,
    port: config.port,
    version: VERSION,
    log
  })

  // Expiry runs at startup (a daemon that was off for a month has a
  // month of overdue evictions) and hourly after.
  const evict = async (): Promise<void> => {
    // Measured fresh each pass: the budget bounds the cache's own use,
    // but real free space bounds what this shared machine can afford —
    // see storage.runEviction.
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

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(config.port, '0.0.0.0', resolve)
  })
  fetcher.start()
  mdns.start()

  const banner = (code: string): void => {
    console.log('')
    console.log('  ┌──────────────────────────────────────────────┐')
    console.log(`  │  r3-cache ${VERSION} — "${config.serverName}"`.padEnd(49) + '│')
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

  const shutdown = async (): Promise<void> => {
    log('shutting down')
    mdns.stop()
    server.close()
    await fetcher.stop()
    process.exit(0)
  }
  process.on('SIGINT', () => void shutdown())
  process.on('SIGTERM', () => void shutdown())
}

void main().catch((error) => {
  console.error(`[r3-cache] failed to start: ${(error as Error).message}`)
  process.exit(1)
})
