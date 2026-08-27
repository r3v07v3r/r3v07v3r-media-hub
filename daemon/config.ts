// r3-cache daemon configuration.
//
// The contract is "run it and it works": every value here has a default a
// person never has to look at, and the optional r3-cache.json beside the
// data directory only OVERRIDES — it is never required, never generated,
// and its absence is the normal case. That file is read once at startup;
// this is a background daemon, not a live-reconfigurable service.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export interface DaemonConfig {
  /** Where everything lives: items/, meta, auth. */
  dataDir: string
  /** HTTP port. One fixed default so discovery and manual entry agree. */
  port: number
  /** Idle expiry: evicted this long after the LAST ACCESS (refreshed on
   *  every play). First layer of "the server never fills up". */
  idleTtlDays: number
  /** Absolute expiry: evicted this long after FETCH, no matter what —
   *  tracked, pinned, or mid-watch. The user's explicit requirement: no
   *  item may live indefinitely. */
  hardMaxDays: number
  /** How long an eviction tombstone suppresses re-queueing the same title. */
  tombstoneDays: number
  /** Disk budget for items, in bytes. 0 = decide from free space at start. */
  diskBudgetBytes: number
  /** Friendly name announced over discovery and shown in the app. */
  serverName: string
}

/** OS-appropriate default data root, overridable via R3_CACHE_DIR. */
export function defaultDataDir(): string {
  const override = process.env.R3_CACHE_DIR
  if (override && override.trim()) return path.resolve(override.trim())
  if (process.platform === 'win32') {
    const base = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
    return path.join(base, 'r3-cache')
  }
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share')
  return path.join(base, 'r3-cache')
}

export const DEFAULTS = {
  port: 8945,
  idleTtlDays: 14,
  hardMaxDays: 30,
  tombstoneDays: 60,
  /** Cap applied to the free-space-derived budget, so a fresh install on a
   *  huge drive doesn't claim the whole thing. */
  maxAutoBudgetBytes: 50 * 1024 ** 3,
  /** Fraction of the FREE space at startup the auto budget may claim. */
  autoBudgetFreeFraction: 0.8
} as const

function readOverrides(dataDir: string): Partial<DaemonConfig> {
  try {
    const raw = fs.readFileSync(path.join(dataDir, 'r3-cache.json'), 'utf8')
    const parsed = JSON.parse(raw) as Record<string, unknown>
    const out: Partial<DaemonConfig> = {}
    if (typeof parsed.port === 'number' && parsed.port >= 1 && parsed.port <= 65535) {
      out.port = Math.floor(parsed.port)
    }
    for (const key of ['idleTtlDays', 'hardMaxDays', 'tombstoneDays'] as const) {
      const value = Number(parsed[key])
      if (Number.isFinite(value) && value > 0) out[key] = value
    }
    const budgetGb = Number(parsed.diskBudgetGb)
    if (Number.isFinite(budgetGb) && budgetGb > 0) {
      out.diskBudgetBytes = budgetGb * 1024 ** 3
    }
    if (typeof parsed.serverName === 'string' && parsed.serverName.trim()) {
      out.serverName = parsed.serverName.trim().slice(0, 64)
    }
    return out
  } catch {
    // Absent or unreadable is the normal, zero-config case.
    return {}
  }
}

/**
 * The resolved configuration the daemon actually runs with.
 *
 * The disk budget default is computed from free space HERE, once, rather
 * than continuously: a budget that silently shrinks as the disk fills
 * would evict items for reasons no log line explains. Real disk pressure
 * is still handled at fetch time (the fetcher refuses to start a download
 * that free space cannot hold).
 */
export function loadConfig(): DaemonConfig {
  const dataDir = defaultDataDir()
  const overrides = readOverrides(dataDir)

  let diskBudgetBytes = overrides.diskBudgetBytes ?? 0
  if (!diskBudgetBytes) {
    try {
      const stat = fs.statfsSync(dataDir)
      const free = stat.bavail * stat.bsize
      diskBudgetBytes = Math.min(
        DEFAULTS.maxAutoBudgetBytes,
        Math.floor(free * DEFAULTS.autoBudgetFreeFraction)
      )
    } catch {
      // dataDir may not exist yet (first run) — statfs the home dir instead,
      // and fall back to the cap if even that fails.
      try {
        const stat = fs.statfsSync(os.homedir())
        diskBudgetBytes = Math.min(
          DEFAULTS.maxAutoBudgetBytes,
          Math.floor(stat.bavail * stat.bsize * DEFAULTS.autoBudgetFreeFraction)
        )
      } catch {
        diskBudgetBytes = DEFAULTS.maxAutoBudgetBytes
      }
    }
  }

  return {
    dataDir,
    port: overrides.port ?? DEFAULTS.port,
    idleTtlDays: overrides.idleTtlDays ?? DEFAULTS.idleTtlDays,
    hardMaxDays: overrides.hardMaxDays ?? DEFAULTS.hardMaxDays,
    tombstoneDays: overrides.tombstoneDays ?? DEFAULTS.tombstoneDays,
    diskBudgetBytes,
    serverName: overrides.serverName ?? os.hostname()
  }
}
