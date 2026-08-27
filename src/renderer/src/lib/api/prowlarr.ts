import { ServiceConfig } from '@shared/ipc-types'
import { proxyFetch } from './proxyFetch'
import { ClientResult, ConnectionTestResult, isConfigured, normalizeBaseUrl } from './types'

// Prowlarr — not a media manager like Sonarr/Radarr, an INDEXER manager they
// both search through. Connecting it here answers a question this app has
// never been able to: when Sonarr or Radarr comes up empty on a title, WHY.
// A generic "no results" is the same message whether every indexer is
// healthy and the release genuinely does not exist yet, or three of five
// are currently locked out on a bad API key — and only Prowlarr, which
// tracks each indexer's own failure state, can tell the two apart.
//
// Same v1 REST shape as the rest of the *arr family (X-Api-Key header),
// but a different surface: no queue, no lookup/add — indexer HEALTH is the
// only thing this app asks it for. Not exercised against a live instance
// (none exists in this sandbox); shaped from the public Prowlarr API docs
// (https://prowlarr.com/docs/api).

interface ProwlarrSystemStatus {
  version?: string
}

interface ProwlarrIndexer {
  id: number
  name: string
}

interface ProwlarrIndexerStatus {
  indexerId: number
  /** ISO timestamp. Prowlarr only lists an indexer here AT ALL while it is
   *  in a backoff window, so presence in this endpoint already means
   *  "currently failing" — this is read for display, not to re-derive that. */
  disabledTill?: string
  mostRecentFailure?: string
}

/** One currently-failing indexer, joined against its name — the shape a
 *  failed-search UI actually wants, rather than the raw id pair Prowlarr's
 *  two separate endpoints report. */
export interface FailingIndexer {
  id: number
  name: string
  disabledTill: string | null
  mostRecentFailure: string | null
}

function headers(config: ServiceConfig): Record<string, string> {
  return config.apiKey ? { 'X-Api-Key': config.apiKey } : {}
}

export async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
  if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
  if (!config.apiKey.trim()) return { ok: false, message: 'API key is required' }
  const base = normalizeBaseUrl(config.baseUrl)
  const res = await proxyFetch<ProwlarrSystemStatus>({
    url: `${base}/api/v1/system/status`,
    method: 'GET',
    headers: headers(config)
  })
  if (!res.ok)
    return { ok: false, message: res.error ?? `Server responded with status ${res.status}` }
  const version = res.data?.version ? ` v${res.data.version}` : ''
  return { ok: true, message: `Connected to Prowlarr${version}` }
}

/**
 * Every indexer Prowlarr currently has in a backoff/failure state — empty
 * when everything is healthy, which is the ordinary case and not treated
 * as an error.
 *
 * Two requests, joined here rather than asked of the caller: `/indexerstatus`
 * only ever carries the numeric `indexerId` Prowlarr uses internally, and a
 * person reading a diagnostic message needs the name they actually gave
 * that indexer, not an id with no meaning outside Prowlarr's own database.
 */
export async function getIndexerStatus(
  config: ServiceConfig
): Promise<ClientResult<FailingIndexer[]>> {
  if (!isConfigured(config)) return { ok: false, live: false, error: "Prowlarr isn't configured" }
  const base = normalizeBaseUrl(config.baseUrl)
  const [statusRes, indexersRes] = await Promise.all([
    proxyFetch<ProwlarrIndexerStatus[]>({
      url: `${base}/api/v1/indexerstatus`,
      method: 'GET',
      headers: headers(config)
    }),
    proxyFetch<ProwlarrIndexer[]>({
      url: `${base}/api/v1/indexer`,
      method: 'GET',
      headers: headers(config)
    })
  ])
  if (!statusRes.ok)
    return { ok: false, live: false, error: statusRes.error ?? `Status ${statusRes.status}` }
  const statuses = statusRes.data ?? []
  if (!statuses.length) return { ok: true, live: true, data: [] }

  // The indexer list is what turns an id into a name a person recognizes.
  // Its own failure degrades to numbered placeholders rather than losing
  // the failure report entirely — knowing indexer #7 is down is still more
  // useful than the message disappearing because a second, unrelated call
  // did not answer.
  const names = new Map((indexersRes.ok ? (indexersRes.data ?? []) : []).map((i) => [i.id, i.name]))
  const failing: FailingIndexer[] = statuses.map((status) => ({
    id: status.indexerId,
    name: names.get(status.indexerId) ?? `Indexer #${status.indexerId}`,
    disabledTill: status.disabledTill ?? null,
    mostRecentFailure: status.mostRecentFailure ?? null
  }))
  return { ok: true, live: true, data: failing }
}
