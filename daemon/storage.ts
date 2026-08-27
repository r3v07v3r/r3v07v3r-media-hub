// The daemon's item store: complete files on disk, and the expiry rules
// that keep the server from filling up indefinitely.
//
// Deliberately whole files, not StreamCache's chunk format. StreamCache is
// a rolling window around a live playhead; this store's whole purpose is
// files that are DONE — fetched ahead of time, served with plain HTTP
// Range requests, the same contract the app already consumes from
// Jellyfin's static file serving.
//
// Layout:  <dataDir>/items/<infoHash>/<video file>
//          <dataDir>/items/<infoHash>/meta.json
//          <dataDir>/tombstones.json

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

import type { CacheSourceRef } from '../src/shared/media-hub/types'

export interface ItemMeta {
  /** catalogId:season:episode — the SAME key the app's cacheContentKey
   *  produces, so daemon and app agree on identity without translation. */
  contentKey: string
  title: string
  infoHash: string
  fileName: string
  sizeBytes: number
  resolution?: number
  sourceRef?: CacheSourceRef
  fetchedAt: number
  lastAccessAt: number
}

export interface StoredItem extends ItemMeta {
  /** Bytes actually on disk right now. Equal to sizeBytes once complete;
   *  smaller while a fetch is mid-flight or was interrupted. */
  presentBytes: number
  complete: boolean
}

export interface EvictionPolicy {
  idleTtlMs: number
  hardMaxMs: number
  budgetBytes: number
}

export type EvictionReason = 'hard-max' | 'idle' | 'budget'

/**
 * Which items must go, and why — pure, so the three-layer expiry rule is
 * unit-testable without a filesystem (same design as StreamCache's
 * computeRetainedChunkIndices).
 *
 * Order matters and is the product rule:
 *  1. hard-max — nothing survives past hardMaxMs after fetch, full stop.
 *     This is the user's explicit "even if it's marked or being watched".
 *  2. idle     — untouched for idleTtlMs since last access.
 *  3. budget   — if what remains still exceeds budgetBytes, evict least
 *     recently accessed until it fits. Keeps the disk bounded even when
 *     everything is young and busy.
 */
export function planEvictions(
  items: readonly StoredItem[],
  policy: EvictionPolicy,
  now: number
): Map<string, EvictionReason> {
  const out = new Map<string, EvictionReason>()
  const survivors: StoredItem[] = []

  for (const item of items) {
    if (now - item.fetchedAt >= policy.hardMaxMs) out.set(item.infoHash, 'hard-max')
    else if (now - item.lastAccessAt >= policy.idleTtlMs) out.set(item.infoHash, 'idle')
    else survivors.push(item)
  }

  let remaining = survivors.reduce((sum, item) => sum + item.presentBytes, 0)
  if (remaining > policy.budgetBytes) {
    // Oldest access first. Stable beyond that on fetchedAt so the plan is
    // deterministic when access times tie (e.g. never-played items).
    const byAge = [...survivors].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt || a.fetchedAt - b.fetchedAt
    )
    for (const item of byAge) {
      if (remaining <= policy.budgetBytes) break
      out.set(item.infoHash, 'budget')
      remaining -= item.presentBytes
    }
  }
  return out
}

const INFO_HASH_RE = /^[a-f0-9]{40}$/

let tmpCounter = 0

async function writeJsonAtomic(filePath: string, value: unknown): Promise<void> {
  // The tmp name must be unique per WRITE, not per file: two concurrent
  // touches of the same item (two Range requests landing together) would
  // otherwise write the same .tmp and race the rename — observed on
  // Windows as EPERM in the test suite.
  const tmp = `${filePath}.${process.pid}.${tmpCounter++}.tmp`
  await fsp.writeFile(tmp, JSON.stringify(value))
  await fsp.rename(tmp, filePath)
}

export interface ItemStore {
  list(): Promise<StoredItem[]>
  find(contentKey: string): Promise<StoredItem | null>
  get(infoHash: string): Promise<StoredItem | null>
  /** Absolute path of an item's video file. */
  filePath(item: StoredItem): string
  /** Directory a fetch writes into; meta is written first so an
   *  interrupted download is still identifiable and resumable. */
  beginItem(meta: ItemMeta): Promise<string>
  /** Refreshes lastAccessAt — this is what the idle TTL counts from. */
  touch(infoHash: string): Promise<void>
  /** Runs the three-layer expiry rule and deletes what it names.
   *  Returns what was evicted, for the log. */
  runEviction(now?: number): Promise<Map<string, EvictionReason>>
  remove(infoHash: string): Promise<void>
  /** contentKey -> evictedAt for TTL/hard-max evictions still suppressing
   *  a re-queue. Budget evictions do NOT tombstone: they reflect pressure,
   *  not disinterest, and tombstoning them would let one oversized fetch
   *  permanently unqueue everything it displaced. */
  tombstones(): Promise<Record<string, number>>
  clearTombstone(contentKey: string): Promise<void>
  usedBytes(): Promise<number>
}

export function createItemStore(
  dataDir: string,
  policy: EvictionPolicy & { tombstoneMs: number }
): ItemStore {
  const itemsDir = path.join(dataDir, 'items')
  const tombstonePath = path.join(dataDir, 'tombstones.json')

  async function readTombstones(): Promise<Record<string, number>> {
    try {
      const parsed = JSON.parse(await fsp.readFile(tombstonePath, 'utf8')) as Record<string, number>
      // Expired tombstones fall away on read; the next write persists that.
      const now = Date.now()
      const live: Record<string, number> = {}
      for (const [key, at] of Object.entries(parsed)) {
        if (Number.isFinite(at) && now - at < policy.tombstoneMs) live[key] = at
      }
      return live
    } catch {
      return {}
    }
  }

  async function readItem(infoHash: string): Promise<StoredItem | null> {
    const dir = path.join(itemsDir, infoHash)
    try {
      const meta = JSON.parse(await fsp.readFile(path.join(dir, 'meta.json'), 'utf8')) as ItemMeta
      let presentBytes = 0
      try {
        presentBytes = (await fsp.stat(path.join(dir, meta.fileName))).size
      } catch {
        // File missing entirely — an interrupted fetch that never wrote a
        // byte. presentBytes 0 is the honest answer.
      }
      return {
        ...meta,
        presentBytes,
        complete: meta.sizeBytes > 0 && presentBytes >= meta.sizeBytes
      }
    } catch {
      return null
    }
  }

  async function list(): Promise<StoredItem[]> {
    let entries: fs.Dirent[]
    try {
      entries = await fsp.readdir(itemsDir, { withFileTypes: true })
    } catch {
      return []
    }
    const items: StoredItem[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || !INFO_HASH_RE.test(entry.name)) continue
      const item = await readItem(entry.name)
      if (item) items.push(item)
    }
    return items
  }

  async function remove(infoHash: string): Promise<void> {
    if (!INFO_HASH_RE.test(infoHash)) return
    await fsp.rm(path.join(itemsDir, infoHash), { recursive: true, force: true })
  }

  return {
    list,
    async find(contentKey) {
      if (!contentKey) return null
      for (const item of await list()) {
        if (item.contentKey === contentKey) return item
      }
      return null
    },
    get: readItem,
    filePath(item) {
      return path.join(itemsDir, item.infoHash, item.fileName)
    },
    async beginItem(meta) {
      if (!INFO_HASH_RE.test(meta.infoHash)) throw new Error('Invalid infoHash.')
      // The file name came over the network; it must not be able to walk
      // out of the item directory.
      if (path.basename(meta.fileName) !== meta.fileName || !meta.fileName.trim()) {
        throw new Error('Invalid file name.')
      }
      const dir = path.join(itemsDir, meta.infoHash)
      await fsp.mkdir(dir, { recursive: true })
      await writeJsonAtomic(path.join(dir, 'meta.json'), meta)
      return dir
    },
    async touch(infoHash) {
      // Best-effort by contract: refreshing the idle TTL must never be able
      // to fail a stream. Concurrent touches can still lose a rename race
      // on Windows even with unique tmp names; the loser's timestamp is a
      // moment staler, which is meaningless for a 14-day TTL.
      try {
        const item = await readItem(infoHash)
        if (!item) return
        // Strip the derived fields; only real metadata goes back to disk.
        const meta: Record<string, unknown> = { ...item, lastAccessAt: Date.now() }
        delete meta.presentBytes
        delete meta.complete
        await writeJsonAtomic(path.join(itemsDir, infoHash, 'meta.json'), meta)
      } catch {
        // See above.
      }
    },
    async runEviction(now = Date.now()) {
      const items = await list()
      const plan = planEvictions(items, policy, now)
      if (plan.size === 0) return plan
      const stones = await readTombstones()
      for (const [infoHash, reason] of plan) {
        await remove(infoHash)
        if (reason !== 'budget') {
          const item = items.find((candidate) => candidate.infoHash === infoHash)
          if (item?.contentKey) stones[item.contentKey] = now
        }
      }
      await writeJsonAtomic(tombstonePath, stones)
      return plan
    },
    remove,
    tombstones: readTombstones,
    async clearTombstone(contentKey) {
      const stones = await readTombstones()
      if (contentKey in stones) {
        delete stones[contentKey]
        await writeJsonAtomic(tombstonePath, stones)
      }
    },
    async usedBytes() {
      const items = await list()
      return items.reduce((sum, item) => sum + item.presentBytes, 0)
    }
  }
}
