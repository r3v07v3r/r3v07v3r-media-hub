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
// Two-tier by necessity: the anime catalog crawl (see kitsuCatalog in
// catalog.ts) walks ~1000 entries. Checking every single one against
// Kitsu's mappings endpoint just to find the ~50-150 that are actually
// multi-season would be both slow and impolite to Kitsu's API. A free,
// zero-API-call title heuristic buckets CANDIDATES first; only buckets with
// 2+ members ever cost a mappings fetch. A false-positive bucket (two
// unrelated titles whose stripped names happen to collide) just costs one
// extra, harmless fetch — real grouping only ever happens when confirmed by
// one of the two signals below, so a heuristic miss can never merge two
// things that don't actually belong together.
//
// Confirmed live that the TVDB mapping alone isn't always enough: Boku no
// Hero Academia seasons 1-3 (Kitsu ids 11469/12268/13881) all map to TVDB
// series 305074 with season suffixes 1/2/3, but seasons 4-6 (41971/43108/
// 45240) have NO thetvdb mapping in Kitsu's data at all — a real coverage
// gap on newer entries, not a bug. Kitsu's OWN sequel/prequel relationship
// graph (already fetched elsewhere for the unrelated "related titles" rail
// — see filterAnimeRelationships) still links season 3 -> season 4 directly
// by Kitsu id even when the external TVDB cross-reference is missing, so
// it's used here as a second confirmation signal via union-find: two bucket
// members merge if they share a TVDB series id OR one's relationships
// include a sequel/prequel edge to the other. Members confirmed only via
// the relationship graph (no TVDB season number) sort after the
// TVDB-confirmed ones, ordered among themselves by ascending Kitsu id —
// Kitsu ids are assigned roughly in upload order, which in practice tracks
// real release order for sequels closely enough to use as a fallback.

import type { CatalogItem, Episode } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { normalizeKitsuAnime, type RawApiPayload } from './core'

// Deliberately broad, not precise — see this file's header comment on why
// an over-eager strip here costs at most one harmless extra fetch, never a
// wrong merge. Covers "Title 2".."Title 99", "Title II"/"Title III" (roman
// numerals up to X), and "Title: Season 2"/"Title Part 2"/"Title 2nd Season".
const TRAILING_SEASON_MARKER =
  /(?:[:\-–—]?\s*(?:season|part|cour)\s*\d+\s*$|[:\-–—]?\s*\d+(?:st|nd|rd|th)\s*season\s*$|\s+(?:[2-9]|[1-9]\d)\s*$|\s+(?:ii|iii|iv|v|vi|vii|viii|ix|x)\s*$)/i

export function animeGroupKey(title: string): string {
  const stripped = String(title || '')
    .trim()
    .replace(TRAILING_SEASON_MARKER, '')
    .trim()
  return (stripped || title).toLowerCase().replace(/[^a-z0-9]+/g, '')
}

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
 *  so checking only a single isolated item's own outgoing edges against
 *  its bucket siblings is enough; no need to also check incoming edges. */
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

/** Union-find over one candidate bucket's members: merges two items when
 *  they share a confirmed TVDB series id, or (only for whichever items
 *  that leaves isolated) when one declares a direct sequel/prequel edge to
 *  another bucket member — see this file's header for why both signals
 *  are needed. Canonical item within each resulting group is whichever has
 *  the lowest known season number; items with no TVDB season number of
 *  their own (only ever reachable via the relationship-edge signal) sort
 *  after every TVDB-confirmed one, ordered by ascending Kitsu id. */
async function resolveBucket(
  bucket: CatalogItem[],
  mappingByItemId: Map<string, TvdbMapping | null>
): Promise<CatalogItem[]> {
  const parent = bucket.map((_, i) => i)
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

  const idToIndex = new Map(bucket.map((item, i) => [item.id, i] as const))
  const seriesToIndex = new Map<string, number>()
  for (let i = 0; i < bucket.length; i++) {
    const mapping = mappingByItemId.get(bucket[i].id)
    if (!mapping) continue
    const existing = seriesToIndex.get(mapping.seriesId)
    if (existing !== undefined) union(existing, i)
    else seriesToIndex.set(mapping.seriesId, i)
  }

  // Only chase the relationship graph for members with no TVDB mapping of
  // their own — the common case (a fully TVDB-mapped franchise) never
  // pays for this extra fetch at all. Deliberately gated on "has no TVDB
  // mapping" rather than "currently isolated": a member can already be
  // merged into a group via a SIBLING's edge (e.g. season 6 -> season 5)
  // while still being the only one whose OWN edges hold the missing link
  // back to the TVDB-confirmed group (season 4 -> season 3) — skipping it
  // just because it "looks" merged already would silently leave two real
  // sub-groups of the same franchise unmerged. Confirmed live this way:
  // Boku no Hero Academia season 4 has no TVDB mapping and both a prequel
  // edge to season 3 (TVDB-confirmed) and a sequel edge to season 5 (also
  // TVDB-less) — checking every TVDB-less member unconditionally, not just
  // ones still isolated at the moment they're checked, is what actually
  // closes that chain regardless of which order the bucket happens to be
  // in. Redundant unions here are harmless no-ops.
  for (let i = 0; i < bucket.length; i++) {
    if (mappingByItemId.get(bucket[i].id)) continue
    const edges = await kitsuSequelEdges(bucket[i].id.replace(/^kitsu:/, ''))
    for (const edge of edges) {
      const destIndex = idToIndex.get(`kitsu:${edge.destId}`)
      if (destIndex !== undefined) union(i, destIndex)
    }
  }

  const groups = new Map<number, { item: CatalogItem; season: number | null }[]>()
  for (let i = 0; i < bucket.length; i++) {
    const root = find(i)
    const list = groups.get(root) || []
    list.push({ item: bucket[i], season: mappingByItemId.get(bucket[i].id)?.season ?? null })
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
      return (
        Number(a.item.id.replace(/^kitsu:/, '')) - Number(b.item.id.replace(/^kitsu:/, ''))
      )
    })
    const [canonical, ...siblings] = group
    result.push({ ...canonical.item, groupedIds: siblings.map((s) => s.item.id) })
  }
  return result
}

/**
 * Groups a small anime result set (e.g. a search result — at most 20 items)
 * WITHOUT the title-heuristic pre-filter groupAnimeCatalog needs to keep
 * the full 1000-item crawl affordable. Real gap found live: Prince of
 * Tennis's sequel is titled "Shin Tennis no Ouji-sama" ("The New Prince of
 * Tennis") — a wholly different Japanese title, not "Prince of Tennis 2" —
 * so the title-strip heuristic never even buckets them together, and the
 * TVDB/relationship confirmation this file relies on never runs at all. A
 * search result set is small enough to just confirm every item directly.
 */
export async function groupAnimeSearchResults(items: CatalogItem[]): Promise<CatalogItem[]> {
  const mappings = await Promise.all(
    items.map((item) => kitsuTvdbMapping(item.id.replace(/^kitsu:/, '')))
  )
  const mappingByItemId = new Map<string, TvdbMapping | null>()
  items.forEach((item, i) => mappingByItemId.set(item.id, mappings[i]))
  return resolveBucket(items, mappingByItemId)
}

/**
 * Groups a flat Kitsu catalog (one entry per season/cour) into one tile per
 * franchise. See this file's header for the two-tier heuristic-then-confirm
 * approach. Non-canonical group members are dropped from the returned
 * array entirely (not just hidden) — their ids live on the canonical item's
 * groupedIds instead, for buildGroupedAnimeVideos to fetch on demand when
 * that title's detail page is actually opened.
 */
export async function groupAnimeCatalog(items: CatalogItem[]): Promise<CatalogItem[]> {
  const buckets = new Map<string, CatalogItem[]>()
  for (const item of items) {
    const key = animeGroupKey(item.title)
    const bucket = buckets.get(key)
    if (bucket) bucket.push(item)
    else buckets.set(key, [item])
  }

  const singles: CatalogItem[] = []
  const candidateBuckets: CatalogItem[][] = []
  for (const bucket of buckets.values()) {
    if (bucket.length === 1) singles.push(bucket[0])
    else candidateBuckets.push(bucket)
  }

  const candidateItems = candidateBuckets.flat()
  const mappingByItemId = new Map<string, TvdbMapping | null>()
  // Paced in batches of 20, same politeness convention kitsuCatalog already
  // uses for the main crawl — candidate buckets are a small fraction of
  // the full catalog, but a popular franchise pass could still be a few
  // hundred items deep.
  for (let i = 0; i < candidateItems.length; i += 20) {
    const batch = candidateItems.slice(i, i + 20)
    const mappings = await Promise.all(
      batch.map((item) => kitsuTvdbMapping(item.id.replace(/^kitsu:/, '')))
    )
    batch.forEach((item, idx) => mappingByItemId.set(item.id, mappings[idx]))
    if (i + 20 < candidateItems.length) {
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
  }

  const grouped: CatalogItem[] = []
  for (const bucket of candidateBuckets) {
    grouped.push(...(await resolveBucket(bucket, mappingByItemId)))
  }

  return [...singles, ...grouped]
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
