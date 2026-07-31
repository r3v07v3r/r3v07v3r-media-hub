// Kitsu (the anime catalog/metadata source — see catalog.ts) models each
// season/cour of a franchise as its own independent top-level resource with
// no franchise/parent concept at all, unlike Simkl (series/movie), which
// already returns one id for a whole show with every season's episodes
// embedded. That's the entire reason multi-season anime like "Boku no Hero
// Academia" show up as separate catalog tiles per season today — there was
// never any grouping logic for Series to begin with, because Simkl's data
// shape never needed one.
//
// The fix bridges through TheTVDB: Kitsu's own `/mappings` endpoint exposes
// a cross-reference to TheTVDB for most non-obscure anime, and TheTVDB DOES
// model the whole franchise as one series — confirmed live against Boku no
// Academia's first three Kitsu ids (11469/12268/13881), all three mapping
// to TheTVDB series 305074 with season suffixes 1/2/3 respectively. Once a
// TheTVDB series id is known, TMDB's `/find?external_source=tvdb_id` bridges
// to a TMDB tv id, and TMDB's own `/tv/{id}/season/{n}` gives real episode
// titles/overviews/stills — plus, for many shows, a native season 0
// ("Specials") entry, which is where OVAs/specials come from here rather
// than any new categorization of our own.
//
// Every item in the catalog is checked directly — no title-matching
// pre-filter. An earlier version bucketed candidates by a stripped title
// first (only checking pairs that shared a stem like "Title"/"Title 2") to
// avoid the cost of querying Kitsu's mappings endpoint for all ~1000 crawled
// entries. That missed real cases: Prince of Tennis's sequel is titled "Shin
// Tennis no Ouji-sama" ("The New Prince of Tennis") — a wholly different
// Japanese title, not "Prince of Tennis 2" — so no title heuristic would
// ever bucket them together. Checking every item costs more upfront (see
// kitsuCatalog's own comment on the resulting crawl time) but is the only
// way to not silently miss franchises like this one.
//
// Confirmed live that the TVDB mapping alone isn't always enough either:
// Boku no Hero Academia seasons 1-3 (Kitsu ids 11469/12268/13881) all map to
// TVDB series 305074 with season suffixes 1/2/3, but seasons 4-6 (41971/
// 43108/45240) have NO thetvdb mapping in Kitsu's data at all — a real
// coverage gap on newer entries. Kitsu's OWN sequel/prequel relationship
// graph (already fetched elsewhere for the unrelated "related titles" rail
// — see filterAnimeRelationships) still links season 3 -> season 4 directly
// by Kitsu id even when the external TVDB cross-reference is missing, so
// it's used here as a second confirmation signal via a single global
// union-find over the whole item set: two items merge if they share a
// TVDB series id, or one's relationships include a sequel/prequel edge to
// the other. Items confirmed only via the relationship graph (no TVDB
// season number) sort after every TVDB-confirmed one in their group,
// ordered among themselves by ascending Kitsu id — Kitsu ids are assigned
// roughly in upload order, which in practice tracks real release order for
// sequels closely enough to use as a fallback.

import type { CatalogItem, Episode } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { normalizeKitsuAnime, type RawApiPayload } from './core'

export interface TvdbMapping {
  seriesId: string
  season: number
}

// Sentinel for "confirmed no TheTVDB mapping exists" — the generic
// getCache<T>(key) helper returns `null` for a cache MISS, so a bare `null`
// can't also mean "cached, and the answer is no" without every miss being
// re-fetched forever. An empty seriesId string is never a valid mapping.
const NO_TVDB_MAPPING: TvdbMapping = { seriesId: '', season: -1 }

/** Cached (30d — this cross-reference essentially never changes once
 *  published) Kitsu-to-TheTVDB mapping for one anime id. Returns null (not
 *  an error) when Kitsu has no thetvdb mapping for it — common for very
 *  new or obscure titles not yet catalogued there. */
export async function kitsuTvdbMapping(kitsuId: string): Promise<TvdbMapping | null> {
  const key = `kitsu:tvdb:${kitsuId}`
  const db = getDatabase()
  const cached = db.getCache<TvdbMapping>(key)
  if (cached) return cached.seriesId ? cached : null

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings`
    )
    const entry = (result.data || []).find(
      (x: RawApiPayload) => x.attributes?.externalSite === 'thetvdb'
    )
    const raw = String(entry?.attributes?.externalId || '')
    const [seriesId, seasonRaw] = raw.split('/')
    const season = Number(seasonRaw)
    const mapping: TvdbMapping =
      seriesId && Number.isInteger(season) && season >= 0 ? { seriesId, season } : NO_TVDB_MAPPING
    db.putCache(key, mapping, 30 * 24 * 60 * 60 * 1000)
    return mapping.seriesId ? mapping : null
  } catch (error) {
    logError('anime:tvdb-mapping', error)
    return null
  }
}

/** Cached (30d) TheTVDB-series-id -> TMDB-tv-id bridge via TMDB's own
 *  /find endpoint. Returns null when TMDB has no matching tv entry, or no
 *  API key is configured — callers fall back to Kitsu's own per-id data
 *  either way, this is never a hard requirement. */
async function tmdbTvIdFromTvdb(tvdbSeriesId: string, apiKey: string): Promise<number | null> {
  const key = `tvdb:tmdb-tv:${tvdbSeriesId}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached > 0 ? cached : null

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(tvdbSeriesId)}?api_key=${encodeURIComponent(apiKey)}&external_source=tvdb_id`
    )
    const id = Number(result.tv_results?.[0]?.id)
    const value = Number.isInteger(id) && id > 0 ? id : -1
    db.putCache(key, value, 30 * 24 * 60 * 60 * 1000)
    return value > 0 ? value : null
  } catch (error) {
    logError('anime:tmdb-tv-id', error)
    return null
  }
}

function normalizeTmdbEpisode(record: RawApiPayload, parentId: string, season: number): Episode {
  const episode = Number(record.episode_number) || 1
  return {
    id: `${parentId}:${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: record.name || `Episode ${episode}`,
    released: record.air_date || '',
    description: record.overview || '',
    thumbnail: record.still_path ? `https://image.tmdb.org/t/p/w300${record.still_path}` : ''
  }
}

/** Cached (24h) real episode list for one TMDB tv season. Returns `[]`
 *  (not an error) on any failure, including a season that doesn't exist
 *  (e.g. probing for a season-0 Specials entry that isn't there) — callers
 *  treat empty as "fall back", never as a hard error. */
async function tmdbSeasonEpisodes(
  tmdbTvId: number,
  seasonNumber: number,
  apiKey: string,
  parentId: string
): Promise<Episode[]> {
  const key = `tmdb:season:${tmdbTvId}:${seasonNumber}`
  const db = getDatabase()
  const cached = db.getCache<Episode[]>(key)
  if (cached) return cached

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/tv/${tmdbTvId}/season/${seasonNumber}?api_key=${encodeURIComponent(apiKey)}`
    )
    const episodes = (result.episodes || []).map((e: RawApiPayload) =>
      normalizeTmdbEpisode(e, parentId, seasonNumber)
    )
    db.putCache(key, episodes, 24 * 60 * 60 * 1000)
    return episodes
  } catch (error) {
    logError('anime:tmdb-season', error)
    return []
  }
}

interface SequelEdge {
  role: 'sequel' | 'prequel'
  destId: string
}

/** Cached (24h) sequel/prequel edges for one Kitsu anime id — confirmed
 *  live these are declared reciprocally (season 4 lists a "prequel" edge to
 *  season 3 AND season 3 independently lists a "sequel" edge to season 4),
 *  so checking only a single item's own outgoing edges against the rest of
 *  the catalog is enough; no need to also check incoming edges. */
async function kitsuSequelEdges(kitsuId: string): Promise<SequelEdge[]> {
  const key = `kitsu:edges:${kitsuId}`
  const db = getDatabase()
  const cached = db.getCache<SequelEdge[]>(key)
  if (cached) return cached
  try {
    const result = await fetchJson<RawApiPayload>(
      // include=destination is required here, not optional — confirmed
      // live that Kitsu omits relationships.destination.data (the id
      // reference itself, not just the sideloaded attributes) entirely
      // without it, despite JSON:API convention normally keeping linkage
      // data independent of `include`.
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`
    )
    const edges: SequelEdge[] = (result.data || [])
      .filter((r: RawApiPayload) => r.attributes?.role === 'sequel' || r.attributes?.role === 'prequel')
      .map((r: RawApiPayload) => ({
        role: r.attributes.role,
        destId: String(r.relationships?.destination?.data?.id || '')
      }))
      .filter((e: SequelEdge) => e.destId)
    db.putCache(key, edges, 24 * 60 * 60 * 1000)
    return edges
  } catch (error) {
    logError('anime:sequel-edges', error)
    return []
  }
}

/**
 * Groups a flat Kitsu item list — the full ~1000-entry popularity crawl
 * (kitsuCatalog) or a small search result set (kitsuSearch) — into one tile
 * per franchise. Every item is checked directly (see this file's header for
 * why a title-matching pre-filter isn't good enough); non-canonical group
 * members are dropped from the returned array entirely, not just hidden —
 * their ids live on the canonical item's groupedIds instead, for
 * buildGroupedAnimeVideos to fetch on demand when that title's detail page
 * is actually opened.
 */
export async function groupAnimeCatalog(items: CatalogItem[]): Promise<CatalogItem[]> {
  const idToIndex = new Map(items.map((item, i) => [item.id, i] as const))
  const mappingByItemId = new Map<string, TvdbMapping | null>()

  // Paced in batches of 20, same politeness convention the crawl itself
  // already uses — every item pays for this fetch now, not just candidates
  // from a title match, so a full crawl genuinely takes minutes rather than
  // seconds; only the 6h-cached refresh pays that cost, not page loads.
  for (let i = 0; i < items.length; i += 20) {
    const batch = items.slice(i, i + 20)
    const mappings = await Promise.all(
      batch.map((item) => kitsuTvdbMapping(item.id.replace(/^kitsu:/, '')))
    )
    batch.forEach((item, idx) => mappingByItemId.set(item.id, mappings[idx]))
    if (i + 20 < items.length) await new Promise((resolve) => setTimeout(resolve, 350))
  }

  const parent = items.map((_, i) => i)
  function find(i: number): number {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]]
      i = parent[i]
    }
    return i
  }
  function union(a: number, b: number): void {
    const ra = find(a)
    const rb = find(b)
    if (ra !== rb) parent[ra] = rb
  }

  const seriesToIndex = new Map<string, number>()
  for (let i = 0; i < items.length; i++) {
    const mapping = mappingByItemId.get(items[i].id)
    if (!mapping) continue
    const existing = seriesToIndex.get(mapping.seriesId)
    if (existing !== undefined) union(existing, i)
    else seriesToIndex.set(mapping.seriesId, i)
  }

  // Only chase the relationship graph for items with no TVDB mapping of
  // their own — the common case (a fully TVDB-mapped franchise) never pays
  // for this extra fetch. Deliberately gated on "has no TVDB mapping"
  // rather than "currently isolated in the union-find": an item can already
  // be merged into a group via a SIBLING's edge (e.g. season 6 -> season 5)
  // while still being the only one whose OWN edges hold the missing link
  // back to the TVDB-confirmed group (season 4 -> season 3) — skipping it
  // just because it "looks" merged already would silently leave two real
  // sub-groups of the same franchise unmerged. Confirmed live this way:
  // Boku no Hero Academia season 4 has no TVDB mapping and both a prequel
  // edge to season 3 (TVDB-confirmed) and a sequel edge to season 5 (also
  // TVDB-less) — checking every TVDB-less item unconditionally, not just
  // ones still isolated when checked, is what actually closes that chain
  // regardless of processing order. Redundant unions here are harmless.
  const needsEdgeCheck = items.filter((item) => !mappingByItemId.get(item.id))
  for (let i = 0; i < needsEdgeCheck.length; i += 20) {
    const batch = needsEdgeCheck.slice(i, i + 20)
    const edgesBatch = await Promise.all(
      batch.map((item) => kitsuSequelEdges(item.id.replace(/^kitsu:/, '')))
    )
    batch.forEach((item, idx) => {
      const srcIndex = idToIndex.get(item.id)
      if (srcIndex === undefined) return
      for (const edge of edgesBatch[idx]) {
        const destIndex = idToIndex.get(`kitsu:${edge.destId}`)
        if (destIndex !== undefined) union(srcIndex, destIndex)
      }
    })
    if (i + 20 < needsEdgeCheck.length) await new Promise((resolve) => setTimeout(resolve, 350))
  }

  const groups = new Map<number, { item: CatalogItem; season: number | null }[]>()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    const list = groups.get(root) || []
    list.push({ item: items[i], season: mappingByItemId.get(items[i].id)?.season ?? null })
    groups.set(root, list)
  }

  const result: CatalogItem[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0].item)
      continue
    }
    group.sort((a, b) => {
      if (a.season !== null && b.season !== null) return a.season - b.season
      if (a.season !== null) return -1
      if (b.season !== null) return 1
      return Number(a.item.id.replace(/^kitsu:/, '')) - Number(b.item.id.replace(/^kitsu:/, ''))
    })
    const [canonical, ...siblings] = group
    result.push({ ...canonical.item, groupedIds: siblings.map((s) => s.item.id) })
  }
  return result
}

/**
 * Builds the full multi-season episode list for a grouped anime's detail
 * page. canonical.groupedIds (set by groupAnimeCatalog) gives the sibling
 * ids in season order; the canonical item itself is always season 1 of the
 * group by construction. Tries the TMDB bridge for real per-episode data;
 * any season TMDB can't resolve falls back to that specific Kitsu id's own
 * synthesized placeholder episodes, renumbered to its real position in the
 * group instead of the hardcoded season 1 normalizeKitsuAnime always
 * assigns on its own — a season is never dropped outright just because
 * TMDB didn't have it.
 */
export async function buildGroupedAnimeVideos(
  canonical: CatalogItem,
  apiKey: string
): Promise<Episode[]> {
  const orderedIds = [canonical.id, ...(canonical.groupedIds || [])]
  const kitsuIds = orderedIds.map((id) => id.replace(/^kitsu:/, ''))
  const parentId = orderedIds[0]

  let tmdbTvId: number | null = null
  if (apiKey) {
    const rootMapping = await kitsuTvdbMapping(kitsuIds[0])
    if (rootMapping) tmdbTvId = await tmdbTvIdFromTvdb(rootMapping.seriesId, apiKey)
  }

  const videos: Episode[] = []
  for (let i = 0; i < kitsuIds.length; i++) {
    const seasonNumber = i + 1
    let episodes: Episode[] = tmdbTvId
      ? await tmdbSeasonEpisodes(tmdbTvId, seasonNumber, apiKey, parentId)
      : []
    if (!episodes.length) {
      try {
        const result = await fetchJson<RawApiPayload>(
          `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuIds[i])}`
        )
        const fallbackItem = normalizeKitsuAnime(result.data || {})
        episodes = fallbackItem.videos.map((v) => ({
          ...v,
          id: `${parentId}:${seasonNumber}:${v.episode}`,
          season: seasonNumber
        }))
      } catch (error) {
        logError('anime:season-fallback', error)
      }
    }
    videos.push(...episodes)
  }

  // Many shows have a native season-0 "Specials" entry on TMDB — this has
  // no corresponding Kitsu id of its own, so there's nothing to fall back
  // to; it's simply included when TMDB has it, skipped otherwise.
  if (tmdbTvId) {
    const specials = await tmdbSeasonEpisodes(tmdbTvId, 0, apiKey, parentId)
    videos.unshift(...specials)
  }

  return videos
}
