// The contract between the app and the r3-cache daemon — service identity,
// default port, and the JSON shapes both sides exchange. Lives in shared/
// because the daemon (electron-free, runs anywhere) and the app's main
// process both import it, and a drift between their views of this protocol
// is exactly the class of bug a shared module exists to prevent.

/** mDNS service type the daemon announces and the app browses for. */
export const LANCACHE_SERVICE_TYPE = '_r3cache._tcp.local'

export const LANCACHE_DEFAULT_PORT = 8945

export interface LanCachePingResponse {
  product: 'r3-cache'
  serverName: string
  version: string
  /** True while no device administers this server. On the UNAUTHENTICATED
   *  ping on purpose: an app that has just found a daemon over mDNS has to
   *  decide whether to offer the claim button before it holds any
   *  credential. */
  unclaimed?: boolean
}

/** What POST /api/pair answers. The request carries a device name and
 *  nothing else — there is no code any more. The token that comes back
 *  authorises NOTHING until an administrator approves it, so the app must
 *  store it and then poll GET /api/pair/status. */
export interface LanCachePairResponse {
  token?: string
  serverName?: string
  status?: 'approved' | 'pending'
}

export interface LanCacheDevice {
  /** Hash of the device's token — safe to show, never the credential. */
  id: string
  deviceName: string
  createdAt: number
  status: 'approved' | 'pending'
  approvedAt: number
  /** null means no allocation of its own; the server default applies. */
  quotaBytes: number | null
  isAdmin: boolean
  isYou: boolean
}

/** One title this device fetched onto the cache server. Only ever the
 *  CALLER's own — see the daemon's /api/items/mine and why the unfiltered
 *  catalog was deleted. */
export interface LanCacheOwnItem {
  infoHash: string
  contentKey: string
  title: string
  sizeBytes: number
  complete: boolean
  lastAccessAt: number
  visibility: 'private' | 'shared'
  /** How many OTHER devices are entitled to it. A count, not ids: the owner
   *  needs to know whether anyone else can reach it, and naming who would
   *  describe households the caller is not part of. */
  sharedWith: number
}

export interface LanCacheDevicesResponse {
  devices: LanCacheDevice[]
  openJoin: boolean
  defaultQuotaPercent: number
  /** What that percentage comes to on this disk, so the admin chooses
   *  against a real figure rather than a ratio. null when no default. */
  defaultQuotaBytes: number | null
  diskBudgetBytes: number
}

export interface LanCacheCatalogItem {
  contentKey: string
  infoHash: string
  title: string
  resolution?: number
  sizeBytes?: number
  complete: boolean
}

export interface LanCacheCatalogResponse {
  items: LanCacheCatalogItem[]
  inFlight: Array<{
    contentKey: string
    state: string
    progressBytes: number
    sizeBytes?: number
  }>
  /** Recently TTL-evicted contentKeys the feeder must NOT immediately
   *  re-queue — see the daemon's tombstone rules. */
  tombstoned: string[]
}

export interface LanCacheJobPayload {
  contentKey: string
  infoHash: string
  title: string
  fileIdx?: number
  resolution?: number
  sizeBytes?: number
  sources?: string[]
  /** Why the feeder asked for it — see WantedTitle.reason. Absent on jobs
   *  queued before this existed, and on anything queued by hand. */
  reason?: 'watching' | 'prefetch'
}

/**
 * What an administrator's "update now" did on the cache server.
 *
 * 'restarting' — going down and coming back on the new build.
 * 'waiting'    — staged, but somebody is watching; it installs when they stop.
 * 'current'    — nothing newer to install.
 * 'disabled'   — updates are switched off on that server.
 */
export interface LanCacheUpdateNowResponse {
  outcome: 'restarting' | 'waiting' | 'current' | 'disabled'
  message: string
}

export interface LanCacheStatusResponse {
  serverName: string
  version: string
  usedBytes: number
  budgetBytes: number
  itemCount: number
  /** Whether the CALLING device's own TorBox account is linked. */
  torboxLinked: boolean
  /** How many paired devices have linked an account — household total. */
  linkedDevices: number
  /** Streams being served right now — what update restarts wait on. */
  activeStreams: number
  // EVERYTHING BELOW IS OPTIONAL, and that is not laziness. A daemon
  // updates itself on its own schedule, so an app carrying these fields
  // will routinely be talking to a server built before they existed —
  // which answers /api/status without them. Typing them as required made
  // the app render `undefined` as a blank figure and silently omit the
  // controls that depend on them, with nothing to say why. Optional is the
  // truth, and it forces every reader to decide what an older server looks
  // like.

  /** What the CALLING device holds, charged the way the eviction planner
   *  charges it: to the fetcher, once, however many devices share it. */
  usedByMeBytes?: number
  /** The allocation this device is held to, or null when none is set and
   *  the whole-disk budget is the only bound. */
  quotaBytes?: number | null
  /** Whether the CALLER administers this server. Decided by the daemon
   *  from what it has on disk — never by anything the app sends. */
  isAdmin?: boolean
  /** True while nobody administers this server. ABSENT means the server
   *  predates administration entirely, which is a different thing from
   *  false and has to be shown differently: false means 'somebody already
   *  has it', absent means 'this server cannot be claimed at all yet'. */
  unclaimed?: boolean
  /** Jobs belonging to OTHER devices, as a count. Their titles are not
   *  sent: the queue would otherwise say what the household is watching to
   *  anyone paired, which is the hole entitlement closed on the catalog. */
  othersJobCount?: number
  updater: {
    channel: string
    enabled: boolean
    checkedAt: number
    latestSeen: string
    staged: string
    stagedAt: number
    lastError: string
  }
  jobs: Array<{
    contentKey: string
    /** The SERIES title. Two episodes of one show carry the same one, which
     *  is why season/episode below exist — without them a queue of episodes
     *  reads as a list of duplicates. */
    title: string
    state: string
    attempts: number
    progressBytes: number
    sizeBytes?: number
    resolution?: number
    /** Absent for films, and for any key that is not catalogId:season:episode. */
    season?: number
    episode?: number
    /** Why it is queued: 'watching' is the next episode of something
     *  somebody is partway through, 'prefetch' is from a watchlist. Absent
     *  on jobs queued before this existed. */
    reason?: 'watching' | 'prefetch'
    /** The device that queued it. Sent to the ADMIN only — every other
     *  caller sees just its own jobs, so its own name would say nothing. */
    ownerName?: string
    lastError?: string
  }>
}
