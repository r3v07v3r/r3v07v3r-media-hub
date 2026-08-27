// Jellyfin as a secondary playback source — the "on-site cache" tier.
//
// This is the main-process client. A separate, much smaller renderer-side
// client already exists (renderer/src/lib/api/jellyfin.ts) and stays where
// it is: the Settings page's Test Connection button has to run against the
// base URL currently typed into the form, which has not been saved yet and
// so cannot be read from any store. Everything to do with *playback*
// happens in main, which is where stream:resolve runs, hence this module.
//
// Deliberately takes its config as an explicit argument rather than
// reading the settings store itself. That keeps this file free of any
// `electron` import, which is what lets tests exercise the parsing and
// URL-building directly under tsx (importing electron from a test fails).
// The store read lives in mediaSources.ts, which is the glue layer.

import { titleMatchesRelease } from './core'
import { fetchJson } from './httpClient'
import type { StreamCandidate } from '../../shared/media-hub/types'

export interface JellyfinConfig {
  baseUrl: string
  apiKey: string
}

/** One entry of MediaSources[].MediaStreams[]. Only the fields actually
 *  read are modeled — this is untrusted output from someone else's server,
 *  and Jellyfin's own schema carries dozens more per stream. */
interface JellyfinMediaStream {
  Type?: string
  Height?: number
  Width?: number
  Codec?: string
  Language?: string
  DisplayTitle?: string
}

interface JellyfinMediaSource {
  Id?: string
  Path?: string
  Size?: number
  Container?: string
  MediaStreams?: JellyfinMediaStream[]
}

export interface JellyfinItem {
  Id?: string
  Name?: string
  SeriesName?: string
  ProductionYear?: number
  IndexNumber?: number
  ParentIndexNumber?: number
  Type?: string
  Path?: string
  MediaSources?: JellyfinMediaSource[]
  ProviderIds?: Record<string, string>
}

interface JellyfinItemsResponse {
  Items?: JellyfinItem[]
}

/** Trailing slashes are routine in a pasted server URL and would produce
 *  a doubled separator. Mirrors the renderer client's own normalizeBaseUrl
 *  so "works in Test Connection, fails at playback" can't happen. */
export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, '')
}

export function isJellyfinConfigured(config: JellyfinConfig | undefined): config is JellyfinConfig {
  return Boolean(config && config.baseUrl.trim() && config.apiKey.trim())
}

/** A stable fingerprint of the config, for cache keys. Deliberately does
 *  NOT include the API key — cache keys end up in the on-disk database,
 *  and a credential has no business being written there. The base URL is
 *  enough: pointing at a different server invalidates, rotating a key does
 *  not (and a rotated key only ever makes calls fail, never succeed with
 *  someone else's data). */
export function jellyfinFingerprint(config: JellyfinConfig | undefined): string {
  return isJellyfinConfigured(config) ? normalizeBaseUrl(config.baseUrl) : 'off'
}

function request<T>(
  config: JellyfinConfig,
  path: string,
  query: Record<string, string> = {}
): Promise<T> {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}${path}`)
  for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value)
  return fetchJson<T>(
    url,
    { headers: { 'X-Emby-Token': config.apiKey, Accept: 'application/json' } },
    // The host is user-supplied, so laneForUrl's host-fragment table can
    // never classify it — name the lane explicitly. A LAN server tolerates
    // far more concurrency than a metered public API, hence its own lane
    // rather than sharing `default` with real upstreams.
    { lane: 'jellyfin', priority: 'interactive', label: 'jellyfin' }
  )
}

const FIELDS = 'MediaSources,ProviderIds,Path,ProductionYear'

/** Jellyfin stores external ids as `{ Imdb: 'tt123' }`, and its
 *  AnyProviderIdEquals filter wants them as `imdb.tt123`. */
function providerFilter(imdbId: string): string {
  return `imdb.${imdbId}`
}

/**
 * Confirms an item REALLY carries the id we filtered on.
 *
 * Never skip this on the grounds that the server was asked to filter.
 * Caught against a live 10.11 instance: when AnyProviderIdEquals is
 * malformed or unsupported, Jellyfin does not error and does not return
 * nothing — it ignores the filter and returns the whole library. Trusting
 * `Items[0]` there meant a search for one film happily returned a
 * completely different one, which downstream is indistinguishable from a
 * correct match and would just play the wrong thing.
 *
 * Key casing varies across versions and provider plugins, so the
 * comparison is case-insensitive on both sides.
 */
function matchesProviderId(item: JellyfinItem, imdbId: string): boolean {
  return Object.entries(item.ProviderIds ?? {}).some(
    ([key, value]) =>
      key.toLowerCase() === 'imdb' && String(value).toLowerCase() === imdbId.toLowerCase()
  )
}

/** The app's media ids look like `tt1234567` or `tt1234567:1:2`. */
export function parseMediaId(id: string): { imdbId: string; season?: number; episode?: number } {
  const [imdbId, season, episode] = String(id).split(':')
  return {
    imdbId,
    season: season ? Number(season) : undefined,
    episode: episode ? Number(episode) : undefined
  }
}

/**
 * Finds the movie on the server that corresponds to a catalog title.
 *
 * Provider-id match first — it is exact and is what a properly-scraped
 * library provides. The name search is the fallback for a library whose
 * metadata never got an IMDb id attached, and it is guarded by the SAME
 * title check the torrent path uses (titleMatchesRelease), so a search for
 * "Dragon Ball" cannot quietly return "Dragon Ball Z".
 */
export async function findMovie(
  config: JellyfinConfig,
  imdbId: string,
  title: string
): Promise<JellyfinItem | null> {
  // Only ask when there is actually an id to ask about. An empty filter is
  // not a narrow query, it is no query — see matchesProviderId.
  if (imdbId) {
    const byProvider = await request<JellyfinItemsResponse>(config, '/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Movie',
      AnyProviderIdEquals: providerFilter(imdbId),
      Fields: FIELDS,
      Limit: '10'
    }).catch(() => null)

    const provided = byProvider?.Items?.find(
      (item) => item.MediaSources?.length && matchesProviderId(item, imdbId)
    )
    if (provided) return provided
  }

  if (!title.trim()) return null
  const byName = await request<JellyfinItemsResponse>(config, '/Items', {
    Recursive: 'true',
    IncludeItemTypes: 'Movie',
    SearchTerm: title,
    Fields: FIELDS,
    Limit: '20'
  }).catch(() => null)

  return (
    byName?.Items?.find(
      (item) => item.MediaSources?.length && titleMatchesRelease(item.Name ?? '', title)
    ) ?? null
  )
}

/**
 * Resolves one episode. Two hops by necessity: the series carries the
 * provider id, the episode carries the file. Asking /Shows/{id}/Episodes
 * for one season is much cheaper than pulling every episode of a
 * long-running show and filtering client-side.
 */
export async function findEpisode(
  config: JellyfinConfig,
  imdbId: string,
  title: string,
  season: number,
  episode: number
): Promise<JellyfinItem | null> {
  let series: JellyfinItem | null = null

  if (imdbId) {
    const byProvider = await request<JellyfinItemsResponse>(config, '/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      AnyProviderIdEquals: providerFilter(imdbId),
      Fields: 'ProviderIds',
      Limit: '10'
    }).catch(() => null)

    // Same trap as findMovie, and worse here: Items[0] of an unfiltered
    // library is simply "whichever series sorted first".
    series = byProvider?.Items?.find((item) => matchesProviderId(item, imdbId)) ?? null
  }

  if (!series && title.trim()) {
    const byName = await request<JellyfinItemsResponse>(config, '/Items', {
      Recursive: 'true',
      IncludeItemTypes: 'Series',
      SearchTerm: title,
      Fields: 'ProviderIds',
      Limit: '20'
    }).catch(() => null)
    series = byName?.Items?.find((item) => titleMatchesRelease(item.Name ?? '', title)) ?? null
  }

  if (!series?.Id) return null

  const episodes = await request<JellyfinItemsResponse>(config, `/Shows/${series.Id}/Episodes`, {
    season: String(season),
    Fields: FIELDS
  }).catch(() => null)

  return (
    episodes?.Items?.find((item) => item.IndexNumber === episode && item.MediaSources?.length) ??
    null
  )
}

/**
 * Jellyfin reports real pixel dimensions; the app's limits and scoring talk
 * in the standard tiers (see appIpc.ts's maxStreamResolution allowlist).
 *
 * Keys off WIDTH, not height. A scope-ratio (2.39:1) film is letterboxed
 * in the container, so a 1080p release of one is 1920x800 — judging it by
 * height would call it 720p, which both under-scores it against a genuine
 * 720p remote and, worse, lets it through a 720p ceiling it should not
 * pass. Width is 1920 either way. Height is the fallback for the odd
 * stream that reports no width, using the equivalent full-frame tiers.
 */
export function resolutionTierForStream(
  width: number | undefined,
  height: number | undefined
): number {
  if (width && Number.isFinite(width)) {
    if (width >= 3000) return 2160
    if (width >= 2200) return 1440
    if (width >= 1600) return 1080
    if (width >= 1100) return 720
    if (width >= 700) return 480
    return 0
  }
  if (!height || !Number.isFinite(height)) return 0
  if (height >= 1700) return 2160
  if (height >= 1200) return 1440
  if (height >= 900) return 1080
  if (height >= 560) return 720
  if (height >= 380) return 480
  return 0
}

function basename(filePath: string | undefined): string {
  if (!filePath) return ''
  const parts = String(filePath).split(/[\\/]/)
  return parts[parts.length - 1] ?? ''
}

/**
 * Converts a Jellyfin item into the same StreamCandidate shape the torrent
 * scrapers produce, so both go through one ranking pass.
 *
 * `cached`/`compatible`/`exact` are all true by construction: the file is
 * already on a server we can reach, we found it by id or a guarded title
 * match, and mpv demuxes whatever container it is in. `name` carries the
 * real filename so the existing release-text scoring (audio language,
 * codec/HDR markers) reads the same signal it reads for a torrent.
 */
export function jellyfinCandidate(item: JellyfinItem): StreamCandidate | null {
  const source = item.MediaSources?.find((candidate) => candidate.Id)
  if (!source?.Id || !item.Id) return null

  const video = source.MediaStreams?.find((stream) => stream.Type === 'Video')
  const audioLanguages = (source.MediaStreams ?? [])
    .filter((stream) => stream.Type === 'Audio')
    .map((stream) => stream.Language)
    .filter((language): language is string => Boolean(language))

  return {
    source: 'mediaserver',
    itemId: item.Id,
    mediaSourceId: source.Id,
    // The filename first, then the library title as a fallback for a
    // server that doesn't expose Path (a locked-down user token).
    name: basename(source.Path ?? item.Path) || item.Name || '',
    title: item.SeriesName ? `${item.SeriesName} ${item.Name ?? ''}`.trim() : (item.Name ?? ''),
    resolution: resolutionTierForStream(video?.Width, video?.Height),
    sizeBytes: Number.isFinite(source.Size) ? source.Size : undefined,
    cached: true,
    compatible: true,
    exact: true,
    // A media server knows its real audio languages, which is strictly
    // better information than inferring them from a release name.
    audioLanguages
  }
}

/**
 * The URL mpv is pointed at.
 *
 * `static=true` is not optional: it makes Jellyfin serve the original file
 * bytes instead of starting a server-side transcode. Transcoding would
 * defeat the entire point (the server is meant to be the cheap, instant
 * tier) and would also make the byte-range behaviour StreamCache relies on
 * far less predictable. The api_key travels in the query string because
 * that is the only auth channel Jellyfin's /Videos endpoint accepts — mpv
 * cannot be handed a custom header.
 */
export function buildStreamUrl(
  config: JellyfinConfig,
  itemId: string,
  mediaSourceId: string
): string {
  const url = new URL(`${normalizeBaseUrl(config.baseUrl)}/Videos/${itemId}/stream`)
  url.searchParams.set('static', 'true')
  url.searchParams.set('mediaSourceId', mediaSourceId)
  url.searchParams.set('api_key', config.apiKey)
  return url.toString()
}
