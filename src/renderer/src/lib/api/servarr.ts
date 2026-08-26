import { ServiceConfig } from '@shared/ipc-types'
import { proxyFetch } from './proxyFetch'
import { ClientResult, ConnectionTestResult, isConfigured, normalizeBaseUrl } from './types'

// Shared client for Sonarr and Radarr — both are "Servarr" family apps and
// expose the same v3 REST shape (/api/v3/system/status, /api/v3/queue,
// X-Api-Key header auth), so one implementation covers both rather than
// duplicating it per service. Not exercised against a live instance (none
// exists in this sandbox); shaped from the public Servarr API docs
// (https://sonarr.tv/docs/api / https://radarr.video/docs/api).

export interface ServarrSystemStatus {
  version?: string
  appName?: string
}

export interface ServarrQueueItem {
  id: number
  title?: string
  series?: { title?: string }
  movie?: { title?: string }
  status?: string
  trackedDownloadStatus?: string
  sizeleft?: number
  size?: number
  timeleft?: string
}

/** A quality profile, as both apps report them. */
export interface ServarrOption {
  id: number
  name: string
}

export interface ServarrRootFolder {
  id: number
  path: string
  freeSpace?: number
}

/**
 * One `/lookup` result. Deliberately loose: the record is posted back to the
 * server verbatim (see `add`), so it must survive the round trip with every
 * field it arrived with, including the ones this app has no name for.
 */
export interface ServarrLookupResult {
  /** Present only when the server has ALREADY added this title. */
  id?: number
  title?: string
  year?: number
  titleSlug?: string
  [key: string]: unknown
}

/** What `add` posts. Pure, and exported, because it is the part of this file
 *  that cannot be verified against a live server here and is easy to get
 *  subtly wrong — see the test beside it. */
export function servarrAddPayload(
  kind: 'sonarr' | 'radarr',
  lookup: ServarrLookupResult,
  options: { qualityProfileId: number; rootFolderPath: string; searchNow: boolean }
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    // The server's own lookup record, first, so anything laid over it below
    // wins — and so every field neither this app nor the person could supply
    // (tvdbId, images, the season list) survives the round trip.
    ...lookup,
    qualityProfileId: options.qualityProfileId,
    rootFolderPath: options.rootFolderPath,
    monitored: true,
    // Different key per app, and not interchangeable: a Sonarr add carrying
    // Radarr's option is accepted and then does nothing, which looks exactly
    // like a broken request.
    addOptions:
      kind === 'sonarr'
        ? { searchForMissingEpisodes: options.searchNow, monitor: 'all' }
        : { searchForMovie: options.searchNow }
  }
  if (kind === 'sonarr') {
    body.seasonFolder = true
  } else {
    // Radarr refuses an add with no availability set, and 'released' is the
    // only value that does not schedule a search for something that is not out
    // yet — an announced-only title otherwise sits in the queue indefinitely.
    body.minimumAvailability = 'released'
  }
  return body
}

function headers(config: ServiceConfig): Record<string, string> {
  return config.apiKey ? { 'X-Api-Key': config.apiKey } : {}
}

export function createServarrClient(kind: 'sonarr' | 'radarr') {
  const label = kind === 'sonarr' ? 'Sonarr' : 'Radarr'

  async function testConnection(config: ServiceConfig): Promise<ConnectionTestResult> {
    if (!config.baseUrl.trim()) return { ok: false, message: 'Server URL is required' }
    if (!config.apiKey.trim()) return { ok: false, message: 'API key is required' }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<ServarrSystemStatus>({
      url: `${base}/api/v3/system/status`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok)
      return { ok: false, message: res.error ?? `Server responded with status ${res.status}` }
    const version = res.data?.version ? ` v${res.data.version}` : ''
    return { ok: true, message: `Connected to ${label}${version}` }
  }

  async function getQueue(config: ServiceConfig): Promise<ClientResult<ServarrQueueItem[]>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<{ records: ServarrQueueItem[] }>({
      url: `${base}/api/v3/queue?pageSize=25`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    return { ok: true, live: true, data: res.data?.records ?? [] }
  }

  // ---- Requesting a title -------------------------------------------------
  //
  // The three calls below are what turns this from a status widget into
  // something that does work. They are deliberately the same shape Overseerr
  // and Jellyseerr use, because that shape is the one the Servarr apps
  // actually document: look the title up through the SERVER (which returns a
  // fully-populated record, including the fields neither this app nor the
  // person could supply), then post that record back with the handful of
  // fields the person chose. Hand-building an add payload is the classic way
  // to end up with a series added under the wrong TVDB entry.

  const resource = kind === 'sonarr' ? 'series' : 'movie'

  async function getProfiles(config: ServiceConfig): Promise<ClientResult<ServarrOption[]>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<ServarrOption[]>({
      url: `${base}/api/v3/qualityprofile`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    return { ok: true, live: true, data: res.data ?? [] }
  }

  async function getRootFolders(config: ServiceConfig): Promise<ClientResult<ServarrRootFolder[]>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<ServarrRootFolder[]>({
      url: `${base}/api/v3/rootfolder`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    return { ok: true, live: true, data: res.data ?? [] }
  }

  /**
   * Finds a title on the server by its IMDb id.
   *
   * `term=imdb:tt…` is the documented lookup syntax for both apps and is the
   * only one worth using here: searching by name would make this app guess
   * between a remake and its original, which is precisely the guess the
   * catalog already resolved when it gave the title an IMDb id.
   *
   * A result that already carries an `id` is a title the server has ALREADY
   * added — the lookup endpoints return the library record when there is one,
   * which is how the panel knows to say "already in Sonarr" rather than
   * offering to add it twice.
   */
  async function lookupByImdb(
    config: ServiceConfig,
    imdbId: string
  ): Promise<ClientResult<ServarrLookupResult | null>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const res = await proxyFetch<ServarrLookupResult[]>({
      url: `${base}/api/v3/${resource}/lookup?term=${encodeURIComponent(`imdb:${imdbId}`)}`,
      method: 'GET',
      headers: headers(config)
    })
    if (!res.ok) return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    return { ok: true, live: true, data: res.data?.[0] ?? null }
  }

  /**
   * Adds a looked-up title, and starts a search for it.
   *
   * The lookup record goes back verbatim with the chosen fields laid over it.
   * `addOptions` differs per app — Sonarr searches for missing EPISODES,
   * Radarr for the MOVIE — and getting it wrong means a title that is added
   * and then sits there doing nothing, which looks exactly like a broken
   * request.
   */
  async function add(
    config: ServiceConfig,
    lookup: ServarrLookupResult,
    options: { qualityProfileId: number; rootFolderPath: string; searchNow: boolean }
  ): Promise<ClientResult<ServarrLookupResult>> {
    if (!isConfigured(config)) return { ok: false, live: false, error: `${label} isn't configured` }
    const base = normalizeBaseUrl(config.baseUrl)
    const body = servarrAddPayload(kind, lookup, options)
    const res = await proxyFetch<ServarrLookupResult>({
      url: `${base}/api/v3/${resource}`,
      method: 'POST',
      // The object, NOT a pre-stringified one: the proxy JSON-encodes `body`
      // itself (see main/ipc/httpProxy.ts), so stringifying here would send a
      // JSON string containing JSON. It does not set a content type for that
      // path, and both Servarr apps reject a POST without one, so the header
      // stays explicit.
      headers: { ...headers(config), 'Content-Type': 'application/json' },
      body
    })
    if (!res.ok) {
      // Both apps answer a duplicate add with a 400 carrying a field-level
      // message. Surfacing that verbatim is better than "Status 400" — it is
      // usually "This series has already been added".
      return { ok: false, live: false, error: res.error ?? `Status ${res.status}` }
    }
    return { ok: true, live: true, data: res.data as ServarrLookupResult }
  }

  return { testConnection, getQueue, getProfiles, getRootFolders, lookupByImdb, add }
}

export const sonarrClient = createServarrClient('sonarr')
export const radarrClient = createServarrClient('radarr')
