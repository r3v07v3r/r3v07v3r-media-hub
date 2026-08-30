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

/**
 * May this device see and stream this item?
 *
 * ONE function, deliberately. Entitlement is checked on the catalog listing
 * and on the stream route, and those two answers must never diverge — an
 * item you cannot see but can stream, or vice versa, is the bug this whole
 * feature exists to prevent.
 *
 * Reads absence as the restrictive case throughout: no `visibility` means
 * private, no `entitled` means nobody but the owner. An item written before
 * these fields existed must not become world-readable because a property is
 * missing — except where it has no identifiable owner at all, which
 * migrateEntitlement below marks explicitly rather than inferring here.
 */
export function isEntitled(item: ItemMeta, deviceId: string): boolean {
  if (item.visibility === 'shared') return true
  if (!deviceId) return false
  if (item.ownerDeviceId && item.ownerDeviceId === deviceId) return true
  return Array.isArray(item.entitled) && item.entitled.includes(deviceId)
}

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
  /**
   * Who paid for this. Copied from the job's ownerDeviceId at beginItem —
   * ownership was already tracked for SPENDING (fetcher.ts bills this
   * device's TorBox token) and simply never recorded on the item, which is
   * why it could not be used for reading.
   *
   * Absent on items written before entitlement existed. Those are the
   * `unknown owner` case the migration below treats as shared: nobody can
   * be identified as their owner, and stranding them where no one can reach
   * them is worse than leaving them visible.
   */
  ownerDeviceId?: string
  /**
   * 'private' — only devices in `entitled` may see or stream it.
   * 'shared'  — any paired device may.
   *
   * Absent means private: an item written before this field existed must not
   * become readable by everyone because a property is missing.
   */
  visibility?: 'private' | 'shared'
  /**
   * Device ids that may see and stream this item.
   *
   * A SET, not a single owner, because the cache holds one copy: when a
   * second device asks for a hash already held, it is added here and streams
   * the existing file rather than triggering a second download. That is the
   * whole point of a shared cache, and it reveals nothing — the asker named
   * that exact release, and could have fetched it on their own account
   * anyway.
   */
  entitled?: string[]
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
  /**
   * Per-device allocation in bytes, keyed by device id.
   *
   * A device that is not in this map has NO quota and is bounded only by
   * the whole-disk budget — which is the state every existing install is
   * in, and the reason this can land without changing what any running
   * cache does. An empty or absent map makes the quota pass a no-op.
   */
  quotas?: ReadonlyMap<string, number>
  /**
   * Items that must not be selected, whatever the reason would have been —
   * in practice, the ones with a /stream response open against them.
   *
   * Handled INSIDE the planner rather than by dropping entries from the
   * plan afterwards. A protected item still occupies its bytes, so
   * removing it from the plan after the fact left the overage it was
   * chosen to relieve unrelieved: one 8 GB film being watched could
   * account for the whole excess, and nothing else was picked to cover it.
   * Skipping it here moves on to the next candidate instead, and its bytes
   * stay counted because it is still on the disk.
   */
  protected?: ReadonlySet<string>
}

export type EvictionReason = 'hard-max' | 'idle' | 'quota' | 'budget'

/** Free space the REST of the machine must keep, whatever the configured
 *  budget says. On a shared box (the deployment target is a host that
 *  also runs a trading system) the cache is the least important tenant,
 *  so when something else fills the disk, the cache is what yields. Same
 *  figure the fetcher refuses to start a download without. */
export const DISK_PRESSURE_MARGIN_BYTES = 2 * 1024 ** 3

/**
 * Which items must go, and why — pure, so the three-layer expiry rule is
 * unit-testable without a filesystem (same design as StreamCache's
 * computeRetainedChunkIndices).
 *
 * Order matters and is the product rule:
 *  1. hard-max — nothing survives past hardMaxMs after fetch, full stop.
 *     This is the user's explicit "even if it's marked or being watched".
 *  2. idle     — untouched for idleTtlMs since last access.
 *  3. quota    — a device over its own allocation loses ITS OWN items,
 *     oldest-accessed first, and nobody else's.
 *  4. budget   — if what remains still exceeds budgetBytes, evict least
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

  const isProtected = (infoHash: string): boolean => policy.protected?.has(infoHash) === true

  for (const item of items) {
    // Age is not a reason to delete what somebody is watching either — a
    // long film past the hard maximum is still a long film in progress.
    // Deferred, not exempt: the next pass takes it once the reader goes.
    if (isProtected(item.infoHash)) survivors.push(item)
    else if (now - item.fetchedAt >= policy.hardMaxMs) out.set(item.infoHash, 'hard-max')
    else if (now - item.lastAccessAt >= policy.idleTtlMs) out.set(item.infoHash, 'idle')
    else survivors.push(item)
  }

  // --- quota: each device against its own allocation ---------------------
  //
  // Charged to the FETCHER, once. An item is counted against ownerDeviceId
  // and against nobody else, however many devices are entitled to it —
  // charge every entitled device and the accounting is gamed by sharing
  // everything; charge nobody and it is gamed by sharing everything too.
  //
  // Ordered by the item's lastAccessAt, which touch() advances for whoever
  // streamed it. So something one person is still watching is not evicted
  // because the device that originally fetched it lost interest — the
  // owner pays for it, but the household's interest keeps it.
  //
  // Items with no owner (the pre-multi-user files) are charged to nobody
  // and reachable only by the whole-disk pass below. There is no device to
  // bill them to, and inventing one would evict a stranger's files.
  if (policy.quotas && policy.quotas.size > 0) {
    const byOwner = new Map<string, StoredItem[]>()
    for (const item of survivors) {
      if (!item.ownerDeviceId) continue
      const owned = byOwner.get(item.ownerDeviceId)
      if (owned) owned.push(item)
      else byOwner.set(item.ownerDeviceId, [item])
    }
    for (const [deviceId, quota] of policy.quotas) {
      const owned = byOwner.get(deviceId)
      if (!owned) continue
      let used = owned.reduce((sum, item) => sum + item.presentBytes, 0)
      if (used <= quota) continue
      const byAge = [...owned].sort(
        (a, b) => a.lastAccessAt - b.lastAccessAt || a.fetchedAt - b.fetchedAt
      )
      for (const item of byAge) {
        if (used <= quota) break
        if (isProtected(item.infoHash)) continue
        out.set(item.infoHash, 'quota')
        used -= item.presentBytes
      }
    }
  }

  // --- budget: the whole disk, on top of everything above ----------------
  const kept = survivors.filter((item) => !out.has(item.infoHash))
  let remaining = kept.reduce((sum, item) => sum + item.presentBytes, 0)
  if (remaining > policy.budgetBytes) {
    // Oldest access first. Stable beyond that on fetchedAt so the plan is
    // deterministic when access times tie (e.g. never-played items).
    const byAge = [...kept].sort(
      (a, b) => a.lastAccessAt - b.lastAccessAt || a.fetchedAt - b.fetchedAt
    )
    for (const item of byAge) {
      if (remaining <= policy.budgetBytes) break
      if (isProtected(item.infoHash)) continue
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
   *  `freeBytes` (real free disk right now, when the caller can measure
   *  it) tightens the budget under external pressure — see runEviction's
   *  own comment. Returns what was evicted, for the log. */
  runEviction(
    now?: number,
    freeBytes?: number | null,
    quotas?: ReadonlyMap<string, number> | null
  ): Promise<Map<string, EvictionReason>>
  remove(infoHash: string): Promise<void>
  /** Adds a device to an item's entitled set. This is the dedupe path: a
   *  device asking for a hash already held is entitled to the existing copy
   *  rather than triggering a second download of the same file. */
  grantEntitlement(infoHash: string, deviceId: string): Promise<void>
  /** Replaces an item's visibility and entitled set outright — what the
   *  owner uses to share or un-share something they fetched. Returns false
   *  if the item is not here. The OWNER is always kept entitled: dropping
   *  yourself from your own item leaves a file you pay for and cannot
   *  reach, which is a mistake, not a choice. */
  setSharing(
    infoHash: string,
    visibility: 'private' | 'shared',
    entitled: readonly string[]
  ): Promise<boolean>
  /** Stamps entitlement onto items written before the fields existed.
   *  Returns how many it changed, so startup can say so once. */
  migrateEntitlement(): Promise<number>
  /** contentKey -> evictedAt for TTL/hard-max evictions still suppressing
   *  a re-queue. Budget evictions do NOT tombstone: they reflect pressure,
   *  not disinterest, and tombstoning them would let one oversized fetch
   *  permanently unqueue everything it displaced. */
  tombstones(): Promise<Record<string, number>>
  clearTombstone(contentKey: string): Promise<void>
  usedBytes(): Promise<number>
  /**
   * Frees space until an incoming item of `bytes` would fit INSIDE the
   * budget, evicting least-recently-accessed items to do it.
   *
   * Called before a fetch starts. Without it the budget was only ever
   * reclaimed after the fact, on the eviction timer, so the cache genuinely
   * sat over its cap between passes — 24.8 GB of a 22.6 GB budget, which is
   * not a rounding error, it is the limit not being a limit.
   *
   * Returns false when no amount of evicting would help, which means the
   * item is bigger than the whole budget. Refusing is the only honest answer
   * there: fetching it would either blow the cap or evict the entire cache
   * to hold one file.
   */
  makeRoomFor(bytes: number, keepInfoHash?: string): Promise<boolean>
  /**
   * The same thing, against ONE DEVICE'S allocation rather than the disk.
   *
   * The whole-cache budget is not the only bound a download has to fit.
   * Checking the file's size against the allocation on its own admitted
   * anybody already near their limit: 9 GB held under a 10 GB allocation
   * plus an 8 GB film is 17 GB, until the hourly sweep takes the older
   * files back. That sweep is the same rule applied later and less kindly,
   * so it is applied here first, deliberately and against the owner's own
   * items only.
   *
   * Returns false when no amount of evicting their own files would help —
   * the file is simply bigger than their whole allocation.
   */
  makeRoomForOwner(options: {
    deviceId: string
    bytes: number
    quota: number
    keepInfoHash?: string
  }): Promise<boolean>
}

export function createItemStore(
  dataDir: string,
  policy: EvictionPolicy & { tombstoneMs: number },
  /**
   * Whether an item has a /stream response open against it right now.
   *
   * Injected rather than imported so the store stays testable without a
   * running server, and defaults to "nothing is playing" — which is the
   * old behaviour, so a caller that does not wire it up is no worse off
   * than before.
   */
  options: { isStreaming?: (infoHash: string) => boolean } = {}
): ItemStore {
  const isStreaming = options.isStreaming ?? ((): boolean => false)
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
    async grantEntitlement(infoHash, deviceId) {
      if (!deviceId) return
      const item = await readItem(infoHash)
      if (!item) return
      const entitled = new Set(item.entitled ?? [])
      if (item.ownerDeviceId) entitled.add(item.ownerDeviceId)
      if (entitled.has(deviceId)) return
      entitled.add(deviceId)
      const meta: Record<string, unknown> = { ...item, entitled: [...entitled] }
      // Derived fields are computed on read; only real metadata goes to disk.
      delete meta.presentBytes
      delete meta.complete
      await writeJsonAtomic(path.join(itemsDir, infoHash, 'meta.json'), meta)
    },

    async setSharing(infoHash, visibility, entitled) {
      const item = await readItem(infoHash)
      if (!item) return false
      const next = new Set(entitled)
      if (item.ownerDeviceId) next.add(item.ownerDeviceId)
      const meta: Record<string, unknown> = { ...item, visibility, entitled: [...next] }
      delete meta.presentBytes
      delete meta.complete
      await writeJsonAtomic(path.join(itemsDir, infoHash, 'meta.json'), meta)
      return true
    },

    async migrateEntitlement() {
      // Neither default is safe to apply quietly to items that predate the
      // rule, so the two cases are distinguished explicitly rather than
      // falling through isEntitled's absence handling:
      //
      //   known owner   -> private, entitled to that owner
      //   unknown owner -> SHARED, because nobody can be identified as its
      //                    owner and stranding a file where no one can reach
      //                    it is worse than leaving it visible
      //
      // The unknown-owner case is real, not defensive: credentials.ts
      // documents the pre-multi-user files that have no owner at all.
      let changed = 0
      for (const item of await list()) {
        if (item.visibility) continue
        const meta: Record<string, unknown> = { ...item }
        delete meta.presentBytes
        delete meta.complete
        if (item.ownerDeviceId) {
          meta.visibility = 'private'
          meta.entitled = [item.ownerDeviceId]
        } else {
          meta.visibility = 'shared'
          meta.entitled = []
        }
        await writeJsonAtomic(path.join(itemsDir, item.infoHash, 'meta.json'), meta)
        changed++
      }
      return changed
    },

    async runEviction(now = Date.now(), freeBytes = null, quotas = null) {
      const items = await list()
      // The configured budget bounds what the cache may USE; real free
      // space bounds what the machine can AFFORD. The effective budget is
      // whichever is tighter: when something else on the box eats the
      // disk, the cache shrinks itself (LRU first) until the pressure
      // margin is honoured again, instead of holding its files while the
      // more important tenant runs out of room.
      let budgetBytes = policy.budgetBytes
      if (typeof freeBytes === 'number' && Number.isFinite(freeBytes)) {
        const itemBytes = items.reduce((sum, item) => sum + item.presentBytes, 0)
        budgetBytes = Math.min(
          budgetBytes,
          Math.max(0, itemBytes + freeBytes - DISK_PRESSURE_MARGIN_BYTES)
        )
      }
      const plan = planEvictions(
        items,
        {
          ...policy,
          budgetBytes,
          quotas: quotas ?? undefined,
          // Given to the PLANNER, not applied to its answer. Dropping a
          // protected item from a finished plan freed nothing in its
          // place; refusing to pick it makes the planner choose something
          // else for the same bytes.
          protected: new Set(items.filter((i) => isStreaming(i.infoHash)).map((i) => i.infoHash))
        },
        now
      )
      if (plan.size === 0) return plan
      const stones = await readTombstones()
      for (const [infoHash, reason] of plan) {
        await remove(infoHash)
        // Only DISINTEREST leaves a tombstone. hard-max and idle mean
        // nobody wanted this; budget and quota mean somebody wanted it and
        // there was no room, and a tombstone would then suppress the refetch
        // the moment room appeared.
        if (reason === 'hard-max' || reason === 'idle') {
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
    },

    async makeRoomFor(bytes, keepInfoHash) {
      if (bytes <= 0) return true
      // Nothing on disk could make this fit, so evicting would be pure loss.
      // Checked FIRST, or a too-big item would empty the cache on its way to
      // failing anyway. Measured against the FULL size, not the remainder:
      // a file bigger than the whole budget is refused whether or not half
      // of it is already down.
      if (bytes > policy.budgetBytes) return false

      const items = await list()
      let used = items.reduce((sum, item) => sum + item.presentBytes, 0)
      // A RESUMED fetch is already partly on disk, and those bytes are
      // already in `used`. Asking for the full size again counts them twice
      // and evicts to make room for space that is not free to begin with.
      // Only the remainder is new.
      const held = keepInfoHash
        ? (items.find((item) => item.infoHash === keepInfoHash)?.presentBytes ?? 0)
        : 0
      const need = Math.max(0, bytes - held)
      if (used + need <= policy.budgetBytes) return true

      // Oldest access first, matching the budget pass in planEvictions — the
      // two answer the same question and should not answer it differently.
      const byAge = [...items]
        // Nor anything with a reader on it, for the same reason the
        // hourly pass skips those: freeing space by deleting the film
        // somebody is watching is not a trade worth making, and the fetch
        // that wanted the room can wait or fail honestly.
        .filter((item) => !isStreaming(item.infoHash))
        // NEVER the item being fetched. A partial is the least-recently
        // accessed thing in the cache almost by definition — nobody has
        // watched it, it is not finished — so plain LRU picks it first,
        // deletes the partial it was called to make room for, and the fetch
        // starts from zero again on every retry. On the slow link this
        // daemon exists for, that is the expensive failure.
        .filter((item) => item.infoHash !== keepInfoHash)
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.fetchedAt - b.fetchedAt)
      for (const item of byAge) {
        if (used + need <= policy.budgetBytes) break
        await remove(item.infoHash)
        used -= item.presentBytes
      }
      // No tombstones. This is pressure, not disinterest — the same reason
      // the budget pass does not leave them, and tombstoning here would stop
      // the feeder ever asking for what it just displaced.
      return used + need <= policy.budgetBytes
    },

    async makeRoomForOwner({ deviceId, bytes, quota, keepInfoHash }) {
      if (bytes <= 0) return true
      // Nothing of theirs could make it fit, so evicting would be pure loss
      // — the same first check makeRoomFor makes, for the same reason, and
      // measured against the FULL size rather than a resume's remainder.
      if (bytes > quota) return false

      const owned = (await list()).filter((item) => item.ownerDeviceId === deviceId)
      let used = owned.reduce((sum, item) => sum + item.presentBytes, 0)
      // A resume's bytes are already inside `used`; only the rest is new.
      const held = keepInfoHash
        ? (owned.find((item) => item.infoHash === keepInfoHash)?.presentBytes ?? 0)
        : 0
      const need = Math.max(0, bytes - held)
      if (used + need <= quota) return true

      const byAge = [...owned]
        // Never what is being fetched, and never what is being watched —
        // the two exclusions makeRoomFor makes, for the same reasons.
        .filter((item) => item.infoHash !== keepInfoHash && !isStreaming(item.infoHash))
        .sort((a, b) => a.lastAccessAt - b.lastAccessAt || a.fetchedAt - b.fetchedAt)
      for (const item of byAge) {
        if (used + need <= quota) break
        await remove(item.infoHash)
        used -= item.presentBytes
      }
      // No tombstones, for the reason the budget pass gives: this is
      // pressure, not the household losing interest.
      return used + need <= quota
    }
  }
}
