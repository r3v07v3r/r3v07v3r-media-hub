// Cross-tracker id resolution for anime. Every tracker integration (MAL,
// Trakt, and Simkl itself) needs to answer some version of "what is this
// title's id on service X" — before this module existed, that logic was
// duplicated and inconsistent: malSync.ts had its own live Kitsu `/mappings`
// lookup (kitsu<->mal only), and nothing else (Trakt's IMDb-keyed import,
// in particular) had any bridge at all, so an anime watched/rated on Trakt
// silently never matched this app's `kitsu:<id>`-keyed anime catalog.
//
// Simkl is used as the primary resolver, not because this app treats Simkl
// as authoritative in general, but because Simkl's own anime records already
// carry native mal/anidb/kitsu (and often imdb) cross-references as one
// bundle from one lookup — it is already doing the cross-referencing job,
// just unused for that purpose until now. `/search/id` is a client-ID-only
// public endpoint (see simklPublicRequest) — resolving a title's cross-refs
// never requires the user to have a Simkl account connected, only a (free)
// Simkl Client ID configured in Settings, same as the app's existing
// catalog/search features.
//
// Kitsu's own `/mappings` endpoint is kept as a fallback for whatever Simkl
// doesn't have (or when no Simkl Client ID is configured at all) — this is
// the same endpoint malSync.ts used exclusively before this module existed.

import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { simklPublicRequest } from './simklClient'
import type { SimklMediaIds } from './simkl'
import type { TaskPriority } from './taskScheduler'

const MAPPING_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Every cross-tracker id this app knows how to use for one raw anime title (not necessarily the canonical/grouped id — see catalog.ts's resolveAnimeGroupTarget for that layer). */
export interface AnimeCrossIds {
  kitsu: number
  mal?: number
  anidb?: number
  imdb?: string
  anilist?: number
}

function numericKitsuId(id: string | number): string {
  return String(id).replace(/^kitsu:/, '')
}

interface KitsuMappingsResponse {
  data?: Array<{ attributes?: { externalSite?: string; externalId?: string | number } }>
}

/** Kitsu's own kitsu-id -> mal-id bridge (ported from malSync.ts's original resolveMalIdForKitsu), used only as a fallback for whatever Simkl's /search/id didn't resolve. */
async function malIdFromKitsuMappings(numericId: string): Promise<number> {
  try {
    const result = await fetchJson<KitsuMappingsResponse>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(numericId)}/mappings`
    )
    const match = (result.data || []).find(
      (m) => m.attributes?.externalSite === 'myanimelist/anime'
    )
    return match ? Number(match.attributes?.externalId) || 0 : 0
  } catch (error) {
    logError('idbridge:kitsu-mappings', error)
    return 0
  }
}

interface KitsuMappingResponse {
  data?: Array<{ id?: string | number }>
}

/** Kitsu's own mal-id -> kitsu-id bridge (ported from malSync.ts's original resolveKitsuIdForMal), used only as a fallback for whatever Simkl's /search/id didn't resolve. */
async function kitsuIdFromKitsuMapping(malId: number): Promise<number> {
  try {
    const result = await fetchJson<KitsuMappingResponse>(
      `https://kitsu.io/api/edge/anime?filter[mappingExternalId]=${encodeURIComponent(String(malId))}&filter[mappingExternalSite]=myanimelist/anime`
    )
    return Number(result.data?.[0]?.id) || 0
  } catch (error) {
    logError('idbridge:kitsu-mapping', error)
    return 0
  }
}

/**
 * Every cross-tracker id known for one raw Kitsu anime id (a single title —
 * this does not resolve which merged franchise group it belongs to; see
 * catalog.ts's resolveAnimeGroupTarget for that). Cached 30 days, the same
 * horizon every other id-mapping cache in this app uses, since a cross-
 * reference between two catalog ids essentially never changes once published.
 */
export async function crossIdsForKitsu(
  kitsuId: string | number,
  priority: TaskPriority = 'interactive'
): Promise<AnimeCrossIds> {
  const numericId = numericKitsuId(kitsuId)
  const key = `idbridge:kitsu:${numericId}`
  const db = getDatabase()
  const cached = db.getCache<AnimeCrossIds>(key)
  if (cached) return cached

  const result: AnimeCrossIds = { kitsu: Number(numericId) }
  try {
    const matches = await simklPublicRequest<Array<{ ids?: SimklMediaIds }>>(
      `/search/id?kitsu=${encodeURIComponent(numericId)}&extended=full`,
      priority
    )
    const ids = matches?.[0]?.ids
    if (ids?.mal) result.mal = ids.mal
    if (ids?.anidb) result.anidb = ids.anidb
    if (ids?.imdb) result.imdb = ids.imdb
    if (ids?.anilist) result.anilist = ids.anilist
  } catch (error) {
    // Not fatal — commonly just "no Simkl Client ID configured" (see
    // simklPublicRequest), which every caller falls back past below.
    logError('idbridge:simkl-search', error)
  }

  if (!result.mal) {
    const malId = await malIdFromKitsuMappings(numericId)
    if (malId) result.mal = malId
  }

  db.putCache(key, result, MAPPING_TTL_MS)
  return result
}

/**
 * Inverse of crossIdsForKitsu: the raw Kitsu id for a title known on another
 * tracker by `service`/`value` (e.g. an IMDb id from a Trakt import, or a MAL
 * id from the MAL list). Returns null when nothing resolves. Cached 30 days.
 */
export async function kitsuIdForExternal(
  service: 'mal' | 'imdb' | 'anidb',
  value: string | number,
  priority: TaskPriority = 'interactive'
): Promise<number | null> {
  const key = `idbridge:rev:${service}:${value}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached || null

  let kitsuId = 0
  try {
    const matches = await simklPublicRequest<Array<{ ids?: SimklMediaIds }>>(
      `/search/id?${service}=${encodeURIComponent(String(value))}&extended=full`,
      priority
    )
    kitsuId = Number(matches?.[0]?.ids?.kitsu) || 0
  } catch (error) {
    logError('idbridge:simkl-reverse', error)
  }

  if (!kitsuId && service === 'mal') {
    kitsuId = await kitsuIdFromKitsuMapping(Number(value))
  }

  db.putCache(key, kitsuId, MAPPING_TTL_MS)
  return kitsuId || null
}
