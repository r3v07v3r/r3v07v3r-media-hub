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
  /** What the CALLING device holds, charged the way the eviction planner
   *  charges it: to the fetcher, once, however many devices share it. */
  usedByMeBytes: number
  /** The allocation this device is held to, or null when none is set and
   *  the whole-disk budget is the only bound. */
  quotaBytes: number | null
  /** Whether the CALLER administers this server. Decided by the daemon
   *  from what it has on disk — never by anything the app sends. */
  isAdmin: boolean
  unclaimed: boolean
  /** Jobs belonging to OTHER devices, as a count. Their titles are not
   *  sent: the queue would otherwise say what the household is watching to
   *  anyone paired, which is the hole entitlement closed on the catalog. */
  othersJobCount: number
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
    title: string
    state: string
    attempts: number
    progressBytes: number
    sizeBytes?: number
    lastError?: string
  }>
}
