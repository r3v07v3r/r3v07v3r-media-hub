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
  torboxLinked: boolean
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
