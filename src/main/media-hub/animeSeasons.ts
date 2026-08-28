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
// the other.
//
// That coverage gap turned out to be large, not an edge case: measured
// live against a real user's crawled catalog (the anime catalog audit,
// 2026-08-10), only 591 of 1,070 TVDB-mapping lookups resolved — 45% of
// crawled anime have no TheTVDB mapping at all. AniList's own relations
// graph (see anilist.ts) is a THIRD signal added for exactly that gap —
// structurally the same shape as Kitsu's own graph (a relationship-type
// label, no season ordinal of its own), from a different provider, so
// anything it confirms that Kitsu's own graph missed closes a real hole;
// anything both confirm is a harmless redundant union.
//
// Ordering within a group now has three tiers, poorest signal last:
// TheTVDB's own real season number first; AniList's broadcast season+year
// (a real chronological signal, see anilistSeasonOrderKey) for members
// TheTVDB couldn't number but AniList could still place on a timeline;
// ascending Kitsu id — assigned roughly in upload order, which in practice
// tracks real release order closely enough — as the last resort when
// neither external source has anything to say.

import type { CatalogItem, Episode } from '../../shared/media-hub/types'
import { fetchJson } from './httpClient'
import { mapWithLimit, type TaskPriority } from './taskScheduler'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { normalizeKitsuAnime, normalizeKitsuEpisode, type RawApiPayload } from './core'
import { anilistTitleInfo, cacheAnilistIdFromMappings, cachedAnilistId } from './anilist'

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
export async function kitsuTvdbMapping(
  kitsuId: string,
  priority: TaskPriority = 'maintenance'
): Promise<TvdbMapping | null> {
  const key = `kitsu:tvdb:${kitsuId}`
  const db = getDatabase()
  const cached = db.getCache<TvdbMapping>(key)
  if (cached) return cached.seriesId ? cached : null

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/mappings`,
      {},
      { priority, label: 'anime franchise mapping' }
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
    // Side effect, not a second request: the same /mappings response also
    // carries an `anilist/anime` entry for most non-obscure titles (see
    // anilist.ts), which groupAnimeCatalog's needsEdgeCheck step below
    // reads back for free — every crawled item's AniList id is already
    // warm in cache by the time it's needed, whether or not TheTVDB
    // mapped this particular item.
    cacheAnilistIdFromMappings(kitsuId, result as { data?: RawApiPayload[] })
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
async function tmdbTvIdFromTvdb(
  tvdbSeriesId: string,
  apiKey: string,
  priority: TaskPriority
): Promise<number | null> {
  const key = `tvdb:tmdb-tv:${tvdbSeriesId}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached > 0 ? cached : null

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(tvdbSeriesId)}?api_key=${encodeURIComponent(apiKey)}&external_source=tvdb_id`,
      {},
      { priority, label: 'TMDB series lookup' }
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
  parentId: string,
  priority: TaskPriority
): Promise<Episode[]> {
  const key = `tmdb:season:${tmdbTvId}:${seasonNumber}`
  const db = getDatabase()
  const cached = db.getCache<Episode[]>(key)
  if (cached) return cached

  try {
    const result = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/tv/${tmdbTvId}/season/${seasonNumber}?api_key=${encodeURIComponent(apiKey)}`,
      {},
      { priority, label: 'TMDB season' }
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

/** One page (Kitsu's own page[limit] ceiling — confirmed live, page[limit]=100
 *  returns HTTP 400) of a Kitsu anime's real per-episode data (title,
 *  synopsis, thumbnail, air date). Kitsu's own /anime/{id} record only
 *  exposes an episodeCount number, never the episodes themselves — this
 *  hits the separate /episodes sub-resource, which does. `meta.count` in
 *  the response is Kitsu's own authoritative total, more trustworthy than
 *  episodeCount (which can be null/estimated for an ongoing show). */
async function kitsuEpisodePage(
  kitsuId: string,
  offset: number,
  parentId: string,
  priority: TaskPriority
): Promise<{ episodes: Episode[]; total: number }> {
  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/episodes?page%5Blimit%5D=20&page%5Boffset%5D=${offset}&sort=number`,
    {},
    { priority, label: 'anime episodes' }
  )
  const episodes = (result.data || []).map((record: RawApiPayload) =>
    normalizeKitsuEpisode(record, parentId)
  )
  const total = Number(result.meta?.count) || episodes.length
  return { episodes, total }
}

/**
 * Walks a Kitsu anime's full real episode list, 20 per page. The first
 * page is what tells us how many there are; the rest are asked for
 * together and paced by the scheduler's kitsu lane rather than by the
 * hand-rolled batch-of-five-then-sleep loop this used to run (see
 * kitsuCatalog in catalog.ts for why that pattern is gone everywhere).
 *
 * Returns `[]` (not an error) on any failure, including a title with no
 * /episodes coverage on Kitsu at all — every caller treats an empty result
 * as "fall back to the synthesized placeholder episodes," never as a hard
 * failure.
 */
export async function kitsuRealEpisodes(
  kitsuId: string,
  parentId: string,
  priority: TaskPriority = 'interactive'
): Promise<Episode[]> {
  try {
    const first = await kitsuEpisodePage(kitsuId, 0, parentId, priority)
    const offsets: number[] = []
    for (let o = 20; o < first.total; o += 20) offsets.push(o)
    const rest = await Promise.all(
      offsets.map((offset) => kitsuEpisodePage(kitsuId, offset, parentId, priority))
    )
    return [...first.episodes, ...rest.flatMap((page) => page.episodes)].sort(
      (a, b) => a.season - b.season || a.episode - b.episode
    )
  } catch (error) {
    logError('anime:episodes', error)
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
async function kitsuSequelEdges(kitsuId: string, priority: TaskPriority): Promise<SequelEdge[]> {
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
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`,
      {},
      { priority, label: 'anime relationships' }
    )
    const edges: SequelEdge[] = (result.data || [])
      .filter(
        (r: RawApiPayload) => r.attributes?.role === 'sequel' || r.attributes?.role === 'prequel'
      )
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
export async function groupAnimeCatalog(
  items: CatalogItem[],
  priority: TaskPriority = 'maintenance'
): Promise<CatalogItem[]> {
  const idToIndex = new Map(items.map((item, i) => [item.id, i] as const))
  const mappingByItemId = new Map<string, TvdbMapping | null>()

  // Every item pays for this fetch, not just candidates from a title
  // match, so a full uncached crawl genuinely takes minutes. That is
  // fine — at `maintenance` it only ever runs in the gaps, and the
  // ungrouped catalog is already cached and usable the whole time.
  //
  // The batch-of-20-then-sleep-350ms loop this used to be is gone: it
  // serialised the whole pass on the slowest item in each batch of
  // twenty, for pacing the kitsu lane now applies across every caller at
  // once. See kitsuCatalog in catalog.ts for the same change and why.
  //
  // Bounded rather than a bare Promise.all over every item, though, and
  // for a reason that has nothing to do with the network: each call runs
  // a synchronous SQLite cache read before it ever reaches a request, so
  // starting two thousand of them in one synchronous pass means two
  // thousand disk reads and two thousand scheduler enqueues back to back
  // on the main thread. The lane governs when the requests go out; this
  // governs how many of these composites exist at once.
  const mappings = await mapWithLimit(items, (item) =>
    kitsuTvdbMapping(item.id.replace(/^kitsu:/, ''), priority)
  )
  items.forEach((item, idx) => mappingByItemId.set(item.id, mappings[idx]))

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
  // Bounded for the same reason as the mapping pass above.
  const edgesByItem = await mapWithLimit(needsEdgeCheck, (item) =>
    kitsuSequelEdges(item.id.replace(/^kitsu:/, ''), priority)
  )
  needsEdgeCheck.forEach((item, idx) => {
    const srcIndex = idToIndex.get(item.id)
    if (srcIndex === undefined) return
    for (const edge of edgesByItem[idx] || []) {
      const destIndex = idToIndex.get(`kitsu:${edge.destId}`)
      if (destIndex !== undefined) union(srcIndex, destIndex)
    }
  })

  // A second attempt at the exact same question, from a different
  // provider — see anilist.ts's own header for why this exists and how
  // its scope/rate-limiting/caching stay inside AniList's terms. Kitsu's
  // own relationship graph above is edge-only too, so anything AniList
  // confirms that Kitsu's own graph missed closes a real gap; anything
  // it also confirms is a harmless redundant union, same as the Kitsu
  // pass's own comment already notes for itself.
  //
  // Every crawled item's AniList id (TVDB-mapped or not) is already warm
  // in cache as a side effect of the TVDB-mapping pass above, so the
  // reverse lookup below can resolve an edge target to a crawled item
  // even when that target WAS TVDB-mapped — matching the Kitsu-edges
  // pass's own "only the source needs to be unmapped, not the
  // destination" scoping.
  const anilistIdByItemId = new Map<string, number>()
  for (const item of items) {
    const anilistId = cachedAnilistId(item.id.replace(/^kitsu:/, ''))
    if (anilistId) anilistIdByItemId.set(item.id, anilistId)
  }
  const itemIndexByAnilistId = new Map<number, number>()
  for (const [itemId, anilistId] of anilistIdByItemId) {
    const index = idToIndex.get(itemId)
    if (index !== undefined) itemIndexByAnilistId.set(anilistId, index)
  }

  const anilistOrderKeyByItemId = new Map<string, number>()
  const anilistLookupIds = needsEdgeCheck
    .map((item) => anilistIdByItemId.get(item.id))
    .filter((id): id is number => Boolean(id))
  if (anilistLookupIds.length) {
    const info = await anilistTitleInfo(anilistLookupIds, priority)
    for (const item of needsEdgeCheck) {
      const anilistId = anilistIdByItemId.get(item.id)
      if (!anilistId) continue
      const srcIndex = idToIndex.get(item.id)
      const titleInfo = info.get(anilistId)
      if (!titleInfo || srcIndex === undefined) continue
      if (titleInfo.seasonOrderKey !== null) {
        anilistOrderKeyByItemId.set(item.id, titleInfo.seasonOrderKey)
      }
      for (const edge of titleInfo.chainEdges) {
        const destIndex = itemIndexByAnilistId.get(edge.targetAnilistId)
        if (destIndex !== undefined) union(srcIndex, destIndex)
      }
    }
  }

  const groups = new Map<
    number,
    { item: CatalogItem; season: number | null; anilistOrderKey: number | null }[]
  >()
  for (let i = 0; i < items.length; i++) {
    const root = find(i)
    const list = groups.get(root) || []
    list.push({
      item: items[i],
      season: mappingByItemId.get(items[i].id)?.season ?? null,
      anilistOrderKey: anilistOrderKeyByItemId.get(items[i].id) ?? null
    })
    groups.set(root, list)
  }

  const result: CatalogItem[] = []
  for (const group of groups.values()) {
    if (group.length === 1) {
      result.push(group[0].item)
      continue
    }
    group.sort((a, b) => {
      // Tier 1: a real TheTVDB season number, when both sides have one.
      if (a.season !== null && b.season !== null) return a.season - b.season
      if (a.season !== null) return -1
      if (b.season !== null) return 1
      // Tier 2: AniList's own broadcast season+year — a real chronological
      // signal, closer to the truth than Kitsu's upload-order id below —
      // for the members TheTVDB couldn't season-number but AniList could
      // still place on a timeline.
      if (a.anilistOrderKey !== null && b.anilistOrderKey !== null) {
        return a.anilistOrderKey - b.anilistOrderKey
      }
      if (a.anilistOrderKey !== null) return -1
      if (b.anilistOrderKey !== null) return 1
      // Tier 3: last resort — Kitsu ids are assigned roughly in upload
      // order, which in practice tracks real release order for sequels
      // closely enough to use once nothing else is known.
      return Number(a.item.id.replace(/^kitsu:/, '')) - Number(b.item.id.replace(/^kitsu:/, ''))
    })
    const [canonical, ...siblings] = group
    result.push({
      ...canonical.item,
      groupedIds: siblings.map((s) => s.item.id),
      episodeCounts: combineGroupEpisodeCounts(group.map((g) => g.item))
    })
  }
  return result
}

/**
 * The real combined season/episode totals for a grouped anime — every
 * member of a group is one real franchise season, so the group's true
 * totals are the member count and the sum of each member's own episode
 * count.
 *
 * Before this, a grouped multi-season show's browse-grid badge silently
 * showed only its canonical member's own (season-1-of-itself) count,
 * because nothing combined the group — see CatalogItem.episodeCounts'
 * own doc comment. Pulled out as its own pure function (no network, no
 * database) so this arithmetic is directly testable without needing to
 * exercise groupAnimeCatalog's TVDB-mapping/union-find machinery.
 */
export function combineGroupEpisodeCounts(members: CatalogItem[]): {
  totalSeasons: number
  totalEpisodes: number
} {
  return {
    totalSeasons: members.length,
    totalEpisodes: members.reduce(
      (sum, member) => sum + (member.episodeCounts?.totalEpisodes ?? member.videos.length),
      0
    )
  }
}

/**
 * Which franchise siblings each crawled anime has, by catalog id, and the
 * inverse: for ANY raw anime catalog id (the canonical id of a group, one
 * of its merged siblings, or an ungrouped item), where it actually lives —
 * the canonical show id it should be read/written under, and its real
 * position within that group.
 *
 * This exists to keep a multi-megabyte JSON.parse off the metadata path
 * (catalog.ts's groupedIdsFor call) and, more importantly, to give every
 * tracker sync (MAL, Trakt, Simkl) one shared answer to "where does this
 * title's progress/rating actually belong." Each tracker hands back its OWN
 * id for a title, which for a merged franchise (e.g. "Naruto: Shippuuden")
 * is a sibling's raw id, not this app's canonical grouped id — writing that
 * progress under the sibling's own id, or under season 1 regardless of its
 * real position, is exactly the bug that left grouped shows like Naruto/
 * Naruto: Shippuuden and Bleach/Bleach: Sennen Kessen-hen never showing as
 * watched even after a full sync.
 *
 * Invalidated by hand rather than given a TTL, because there are exactly
 * two writers (catalog.ts's catalogData and its anime-grouping pass) — a
 * stale index here would mean a grouped anime silently losing its later
 * seasons, which is not something to leave to a timer.
 */
let animeGroupIndex: Map<string, string[]> | null = null

/** See animeGroupIndex's own doc — built together in one pass since both read the same cached catalog blob. */
let animeGroupPositionIndex: Map<string, { id: string; season: number }> | null = null

export function invalidateAnimeGroupIndex(): void {
  animeGroupIndex = null
  animeGroupPositionIndex = null
}

function buildAnimeGroupIndexes(): void {
  const items =
    getDatabase().getCache<CatalogItem[]>('catalog:v2:anime', { allowExpired: true }) || []
  const groupIndex = new Map<string, string[]>()
  const positionIndex = new Map<string, { id: string; season: number }>()
  for (const item of items) {
    if (!item.groupedIds?.length) continue
    const id = String(item.id)
    groupIndex.set(id, item.groupedIds as string[])
    // The canonical item is always season 1 of its own group by
    // construction — see buildGroupedAnimeVideos above, which assigns
    // season numbers the same way (canonical = i+1 for i=0).
    positionIndex.set(id, { id, season: 1 })
    item.groupedIds.forEach((siblingId, index) => {
      positionIndex.set(String(siblingId), { id, season: index + 2 })
    })
  }
  animeGroupIndex = groupIndex
  animeGroupPositionIndex = positionIndex
}

export function groupedIdsFor(catalogId: string): string[] | undefined {
  if (!animeGroupIndex) buildAnimeGroupIndexes()
  return animeGroupIndex!.get(String(catalogId))
}

/**
 * Resolves any raw anime catalog id to where it actually belongs: the
 * canonical show id every read/write in this app keys watch history and
 * ratings on, plus its real season number within that group. An id with no
 * group (including a canonical item with no siblings, or a title that was
 * never grouped at all) resolves to itself at season 1 — the same season
 * buildGroupedAnimeVideos assigns an ungrouped title's own videos to. See
 * animeGroupIndex's own doc for why this matters to every tracker sync.
 */
export function resolveAnimeGroupTarget(catalogId: string): { id: string; season: number } {
  if (!animeGroupPositionIndex) buildAnimeGroupIndexes()
  return animeGroupPositionIndex!.get(String(catalogId)) || { id: String(catalogId), season: 1 }
}

/**
 * Builds the full multi-season episode list for a grouped anime's detail
 * page. canonical.groupedIds (set by groupAnimeCatalog) gives the sibling
 * ids in season order; the canonical item itself is always season 1 of the
 * group by construction. Tries the TMDB bridge for real per-episode data
 * first; any season TMDB can't resolve (no TVDB mapping, or no TMDB key
 * configured) falls back to that specific Kitsu id's own real /episodes
 * data (kitsuRealEpisodes) renumbered to its real position in the group,
 * and only if Kitsu has no /episodes coverage for it either falls back
 * again to normalizeKitsuAnime's synthesized "Episode N" placeholders — a
 * season is never dropped outright just because TMDB didn't have it.
 */
export async function buildGroupedAnimeVideos(
  canonical: CatalogItem,
  apiKey: string,
  priority: TaskPriority = 'interactive'
): Promise<Episode[]> {
  const orderedIds = [canonical.id, ...(canonical.groupedIds || [])]
  const kitsuIds = orderedIds.map((id) => id.replace(/^kitsu:/, ''))
  const parentId = orderedIds[0]

  let tmdbTvId: number | null = null
  if (apiKey) {
    const rootMapping = await kitsuTvdbMapping(kitsuIds[0], priority)
    if (rootMapping) tmdbTvId = await tmdbTvIdFromTvdb(rootMapping.seriesId, apiKey, priority)
  }

  const videos: Episode[] = []
  for (let i = 0; i < kitsuIds.length; i++) {
    const seasonNumber = i + 1
    let episodes: Episode[] = tmdbTvId
      ? await tmdbSeasonEpisodes(tmdbTvId, seasonNumber, apiKey, parentId, priority)
      : []
    if (!episodes.length) {
      const real = await kitsuRealEpisodes(kitsuIds[i], parentId, priority)
      if (real.length) {
        episodes = real.map((v) => ({
          ...v,
          id: `${parentId}:${seasonNumber}:${v.episode}`,
          season: seasonNumber
        }))
      } else {
        try {
          const result = await fetchJson<RawApiPayload>(
            `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuIds[i])}`,
            {},
            { priority, label: 'anime season fallback' }
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
    }
    videos.push(...episodes)
  }

  // Many shows have a native season-0 "Specials" entry on TMDB — this has
  // no corresponding Kitsu id of its own, so there's nothing to fall back
  // to; it's simply included when TMDB has it, skipped otherwise.
  if (tmdbTvId) {
    const specials = await tmdbSeasonEpisodes(tmdbTvId, 0, apiKey, parentId, priority)
    videos.unshift(...specials)
  }

  return videos
}
