// Ported from r3v07v3r-media-hub's src/main.cjs — the catalog-domain
// functions (aggregating/caching the Simkl/Kitsu/Cinemeta movie, series and
// anime catalogs, metadata lookup, search, "related titles", and TMDB
// connect/disconnect). Every fallback/cache-staleness path from the
// original is preserved exactly: catalogData's try-primary-source →
// Cinemeta-fallback (non-anime only) → stale-cache → rethrow chain,
// metadata's try-live → stale-catalog-entry (+ Simkl episode refetch for
// series) fallback, and relatedAnime/similarTitles' try → log → stale-cache
// fallback. Do not simplify or drop any of these branches without
// re-auditing against the source app.
//
// One thing here is deliberately NOT a 1:1 port any more: "related
// titles". The original resolved a movie's TMDB collection — its
// franchise — which meant the Similar panel offered you the sequel to
// the film you were already looking at, and offered nothing at all for
// the majority of films that belong to no collection, for series, or for
// anyone without a TMDB key. See similarTitles below for what it does
// instead, and why the franchise lookup is still here doing the opposite
// job.

import type { CatalogItem, ConnectResult, Episode, MediaKind } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import { fetchJson } from './httpClient'
import { logError } from './logger'
import { getDatabase } from './dbState'
import { handle } from './ipcGuard'
import { simklPublicRequest } from './simklClient'
import { isValidCatalogKind } from './security'
import { encrypt, readSettings, tmdbCredentials, writeSettings } from './settingsStore'
import {
  dedupeCatalog,
  disambiguateVideos,
  filterAnimeRelationships,
  normalizeKitsuAnime,
  normalizeMeta,
  normalizeSimklCatalog,
  normalizeSimklSearchResult,
  normalizeTmdbTitle,
  type RawApiPayload
} from './core'
import { isLikelyFranchiseSibling, rankSimilarTitles } from '../../shared/media-hub/catalog-logic'
import { buildGroupedAnimeVideos, groupAnimeCatalog, kitsuRealEpisodes } from './animeSeasons'
import { omdbRottenTomatoesRating } from './omdb'

const catalogUrls: Record<'movie' | 'series', string> = {
  movie: 'https://v3-cinemeta.strem.io/catalog/movie/top.json',
  series: 'https://v3-cinemeta.strem.io/catalog/series/top.json'
}

/** Cached (7d) Kitsu genre/category titles for one anime id. */
async function kitsuCategories(id: string): Promise<string[]> {
  const key = `kitsu:categories:${id}`
  const db = getDatabase()
  const cached = db.getCache<string[]>(key)
  if (cached) return cached

  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime/${encodeURIComponent(id)}/categories?page%5Blimit%5D=20`
  )
  const genres: string[] = (result.data || [])
    .map((x: RawApiPayload) => x.attributes?.title)
    .filter(Boolean)
  db.putCache(key, genres, 7 * 24 * 60 * 60 * 1000)
  return genres
}

/** Merges Simkl's week/month trending feeds for one section into a deduped catalog, dropping unmatched (no-imdb) entries. */
async function simklCatalog(kind: Exclude<MediaKind, 'anime'>): Promise<CatalogItem[]> {
  const section = kind === 'series' ? 'tv' : 'movies'
  const feeds = await Promise.all(
    ['week', 'month'].map((span) =>
      fetchJson<RawApiPayload[]>(
        `https://data.simkl.in/discover/trending/${section}/${span}_500.json`
      )
    )
  )
  return dedupeCatalog(
    feeds.map((result) =>
      (result || [])
        .map((x) => normalizeSimklCatalog(x, kind))
        .filter((x) => x.id && !x.id.startsWith('simkl:'))
    )
  )
}

/** One page (20 items) of Kitsu's most-popular-anime listing, with genre titles resolved from the included `categories` sideload. */
async function kitsuPage(offset: number): Promise<CatalogItem[]> {
  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime?sort=-userCount&page%5Blimit%5D=20&page%5Boffset%5D=${offset}&include=categories`
  )
  const categories = new Map<string, string | undefined>(
    (result.included || [])
      .filter((x: RawApiPayload) => x.type === 'categories')
      .map((x: RawApiPayload) => [String(x.id), x.attributes?.title])
  )
  return (result.data || [])
    .map((record: RawApiPayload) => ({
      ...record,
      attributes: {
        ...record.attributes,
        genres: (record.relationships?.categories?.data || [])
          .map((x: RawApiPayload) => categories.get(String(x.id)))
          .filter(Boolean)
      }
    }))
    .map((record) => normalizeKitsuAnime(record, true))
}

/** Walks Kitsu's popularity ranking 1000 entries deep (5 pages of 20 fetched concurrently per 100-offset batch, 350ms between batches to stay polite to the API). */
async function kitsuCatalog(): Promise<CatalogItem[]> {
  const pages: CatalogItem[][] = []
  for (let offset = 0; offset < 1000; offset += 100) {
    pages.push(...(await Promise.all([0, 20, 40, 60, 80].map((step) => kitsuPage(offset + step)))))
    if (offset < 900) await new Promise((resolve) => setTimeout(resolve, 350))
  }
  // Kitsu has no franchise concept — each season/cour is its own top-level
  // entry (see animeSeasons.ts's header) — so multi-season anime would
  // otherwise show up as one catalog tile per season instead of per show.
  // groupAnimeCatalog checks every item directly (no title-match shortcut,
  // see its own header for why that isn't reliable enough) — a full,
  // uncached crawl now takes a few minutes rather than tens of seconds as
  // a result, but only on the 6h cache refresh below, never on a page load.
  return groupAnimeCatalog(dedupeCatalog(pages))
}

/**
 * The cached top-level catalog for one kind (movie/series/anime). Tries the
 * broad source first (Kitsu for anime, Simkl trending otherwise); on
 * failure or an empty result, non-anime kinds fall back to Cinemeta's top
 * list; if that also comes up empty, falls back to a stale cache entry
 * (even if expired) before finally rethrowing the original error.
 */
export async function catalogData(kind: MediaKind, force = false): Promise<CatalogItem[]> {
  if (!['movie', 'series', 'anime'].includes(kind)) throw new Error('Unknown catalog.')
  const key = `catalog:v2:${kind}`
  const db = getDatabase()
  if (!force) {
    const cached = db.getCache<CatalogItem[]>(key)
    if (cached) return cached
  }

  let items: CatalogItem[] | null | undefined
  try {
    items = kind === 'anime' ? await kitsuCatalog() : await simklCatalog(kind)
    if (!items.length) throw new Error('The broad catalog returned no titles.')
  } catch (primaryError) {
    if (kind !== 'anime') {
      try {
        const result = await fetchJson<{ metas?: RawApiPayload[] }>(catalogUrls[kind])
        items = (result.metas || []).map((x) => normalizeMeta(x, kind))
      } catch {
        items = null
      }
    }
    if (!items?.length) {
      const stale = db.getCache<CatalogItem[]>(key, { allowExpired: true })
      if (stale?.length) return stale
      throw primaryError
    }
  }

  db.putCache(key, items, 6 * 60 * 60 * 1000)
  return items
}

// `season || 1` would silently turn a real season 0 (Simkl's own specials
// convention, same as TMDB's) into season 1 — 0 is falsy in JS, not
// "missing". Only a genuinely non-numeric/absent value should fall back.
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/** Normalizes one raw Simkl `/tv/episodes/:id` entry into our Episode shape. */
function simklEpisode(record: RawApiPayload, parentId: string): Episode {
  const season = numberOr(record.season, 1)
  const episode = numberOr(record.episode, 1)
  return {
    id: `${parentId}:${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: record.title || `Episode ${episode}`,
    released: record.date || '',
    description: record.description || '',
    thumbnail: record.img ? `https://simkl.in/episodes/${record.img}_w.jpg` : ''
  }
}

/** Resolves a `simkl:<id>` catalog id to its IMDb id (the id form every other lookup/streaming path expects). Throws if Simkl has no IMDb mapping for it. */
async function resolveSimklId(type: MediaKind, simklId: string): Promise<string> {
  const endpointType = type === 'series' ? 'tv' : 'movies'
  const result = await simklPublicRequest<RawApiPayload>(
    `/${endpointType}/${encodeURIComponent(simklId)}?extended=full`
  )
  const imdb = result?.ids?.imdb
  if (!imdb) throw new Error('This title could not be matched to a playable source.')
  return imdb
}

/**
 * Cached (24h) full metadata for one title. `simkl:*` ids are resolved to
 * IMDb first. Anime pulls from Kitsu (with categories merged in); movie/
 * series pulls from Cinemeta. On failure, falls back to the matching entry
 * already present in the (possibly stale) top-level catalog cache — with,
 * for series that have a known `simklId`, a live re-fetch of Simkl's
 * episode list so continue-watching/episode data isn't just an empty array.
 */
export async function metadata(type: MediaKind, id: string): Promise<CatalogItem> {
  const resolvedId = String(id).startsWith('simkl:')
    ? await resolveSimklId(type, String(id).slice(6))
    : id
  const cacheKey = `meta:v3:${type}:${resolvedId}`
  const db = getDatabase()
  const cached = db.getCache<CatalogItem>(cacheKey)
  // Re-running disambiguateVideos here (not just on the fresh-fetch path
  // below) matters for anyone upgrading into this fix: their existing 24h
  // cache entries were written by the old code and would otherwise keep
  // serving the duplicate-id videos this whole change exists to remove
  // until each entry's TTL happens to expire on its own. The function is
  // idempotent — an already-disambiguated list has no remaining
  // season/episode duplicates for it to find on a second pass — so this
  // is safe to apply unconditionally rather than needing a cache-key
  // version bump (which would force-refetch every cached title instead
  // of just re-running a cheap, pure, synchronous transform on data
  // that's already there).
  if (cached) return { ...cached, videos: disambiguateVideos(cached.videos) }

  let item: CatalogItem
  try {
    if (type === 'anime') {
      const kitsuId = String(resolvedId)
        .replace(/^kitsu:/, '')
        .split(':')[0]
      const [result, genres] = await Promise.all([
        fetchJson<RawApiPayload>(`https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}`),
        kitsuCategories(kitsuId)
      ])
      item = normalizeKitsuAnime({
        ...result.data,
        attributes: { ...result.data?.attributes, genres }
      })
    } else {
      const result = await fetchJson<{ meta?: RawApiPayload }>(
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(resolvedId)}.json`
      )
      item = normalizeMeta(result.meta || {}, type)
    }
  } catch (primaryError) {
    const source = (
      db.getCache<CatalogItem[]>(`catalog:v2:${type}`, { allowExpired: true }) || []
    ).find((x) => String(x.id) === String(resolvedId))
    if (!source) throw primaryError
    item = { ...source, videos: [] }
    if (type === 'series' && source.simklId) {
      const episodes = await fetchJson<RawApiPayload[]>(
        `https://api.simkl.com/tv/episodes/${encodeURIComponent(String(source.simklId))}`
      )
      item.videos = (episodes || []).map((x) => simklEpisode(x, resolvedId))
    }
  }

  // A grouped anime's own per-id fetch above has no franchise knowledge of
  // its own — groupedIds only ever exists on the CATALOG-list entry (see
  // groupAnimeCatalog in animeSeasons.ts), never on a fresh
  // normalizeKitsuAnime() result — so it's picked up here from that cached
  // list, then used to build the real multi-season episode list in place
  // of whatever single-season data the fetch above produced on its own.
  if (type === 'anime' && !item.groupedIds) {
    const catalogEntry = (
      db.getCache<CatalogItem[]>('catalog:v2:anime', { allowExpired: true }) || []
    ).find((x) => String(x.id) === String(resolvedId))
    if (catalogEntry?.groupedIds?.length) item.groupedIds = catalogEntry.groupedIds
  }
  if (type === 'anime' && item.groupedIds?.length) {
    try {
      item.videos = await buildGroupedAnimeVideos(item, tmdbCredentials().apiKey)
    } catch (error) {
      logError('anime:grouped-videos', error)
    }
  } else if (type === 'anime' && item.videos.length) {
    // Ungrouped (single-season) anime: item.videos above is still
    // normalizeKitsuAnime's synthesized "Episode N" placeholder list —
    // Kitsu's own /anime/{id} record never carries real per-episode data,
    // only episodeCount. Real titles/thumbnails/synopses live on Kitsu's
    // separate /episodes sub-resource (see kitsuRealEpisodes) — try that
    // before falling back to keeping the placeholders, same as the grouped
    // path already does per-season.
    const kitsuId = String(resolvedId)
      .replace(/^kitsu:/, '')
      .split(':')[0]
    const real = await kitsuRealEpisodes(kitsuId, item.id)
    if (real.length) item.videos = real
  }

  // Movie/series only — by this point resolvedId is a real IMDb id (either
  // Cinemeta's own meta.id, or resolveSimklId's live IMDb lookup above), and
  // OMDb is the only one of this app's metadata sources with any Rotten
  // Tomatoes coverage. Anime is skipped: Kitsu ids have no IMDb mapping
  // fetched anywhere in this app, and OMDb/RT have essentially no anime
  // coverage even when a mapping exists, so there's nothing worth the extra
  // round trip. omdbRottenTomatoesRating already no-ops (returns undefined)
  // when OMDb isn't connected, so this is always safe to call unconditionally.
  if (type !== 'anime') {
    item.rottenTomatoesRating = await omdbRottenTomatoesRating(String(resolvedId))
  }

  // Applied once here rather than per-source (Cinemeta/Simkl-fallback/
  // grouped-anime all assign item.videos above) — see disambiguateVideos'
  // own doc comment for why this is needed and what it does.
  item.videos = disambiguateVideos(item.videos)

  db.putCache(cacheKey, item, 24 * 60 * 60 * 1000)
  return item
}

/** Free-text anime search against Kitsu. Grouped the same way the browse
 *  catalog is (see kitsuCatalog) — a searched multi-season franchise not
 *  popular enough to be in the top-1000 crawl would otherwise show every
 *  season as its own result here regardless of that fix. A search result
 *  set is small (20 items max) so this never needs the crawl's own
 *  candidate-bucket pre-filtering cost concern. */
async function kitsuSearch(query: string): Promise<CatalogItem[]> {
  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(query)}&page%5Blimit%5D=20`
  )
  return groupAnimeCatalog((result.data || []).map((record) => normalizeKitsuAnime(record, true)))
}

/** Free-text movie/series search against Simkl. */
async function simklSearch(kind: MediaKind, query: string): Promise<CatalogItem[]> {
  const endpointType = kind === 'series' ? 'tv' : 'movie'
  const result = await simklPublicRequest<RawApiPayload[] | RawApiPayload>(
    `/search/${endpointType}?q=${encodeURIComponent(query)}&extended=full`
  )
  return (Array.isArray(result) ? result : []).map((x) => normalizeSimklSearchResult(x, kind))
}

/** Cached (24h) franchise-relationship anime titles (sequel/prequel/side-story/etc.) from Kitsu, falling back to a stale cache entry (or `[]`) on error rather than failing the caller. */
async function relatedAnime(id: string): Promise<CatalogItem[]> {
  const key = `related:v1:anime:${id}`
  const db = getDatabase()
  const cached = db.getCache<CatalogItem[]>(key)
  if (cached) return cached

  try {
    const kitsuId = String(id)
      .replace(/^kitsu:/, '')
      .split(':')[0]
    const result = await fetchJson<RawApiPayload>(
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`
    )
    const entries = filterAnimeRelationships(result)
    db.putCache(key, entries, 24 * 60 * 60 * 1000)
    return entries
  } catch (error) {
    logError('catalog:related:anime', error)
    return db.getCache<CatalogItem[]>(key, { allowExpired: true }) || []
  }
}

function tmdbId(value: unknown): number | null {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? n : null
}

/** How many suggestions the similar-titles panel is willing to show. Also
 *  the cap on TMDB external-id lookups per title, since each candidate
 *  costs one request to turn a TMDB id into the IMDb id everything else
 *  in this app is keyed by. */
const SIMILAR_LIMIT = 12

/** Cached (30d) TMDB genre-id → name dictionary for one media type. TMDB's
 *  list endpoints return `genre_ids` rather than names, and this mapping
 *  changes about never, so it's fetched once and reused. Returns an empty
 *  map on failure — genres are enrichment here, not something worth
 *  failing a suggestion list over. */
async function tmdbGenreNames(apiKey: string, kind: 'movie' | 'tv'): Promise<Map<number, string>> {
  const key = `tmdb:genres:v1:${kind}`
  const db = getDatabase()
  const cached = db.getCache<[number, string][]>(key)
  if (cached) return new Map(cached)
  try {
    const result = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/genre/${kind}/list?api_key=${encodeURIComponent(apiKey)}`
    )
    const pairs: [number, string][] = (result.genres || [])
      .map((g: RawApiPayload) => [tmdbId(g.id), String(g.name || '')] as [number | null, string])
      .filter((pair): pair is [number, string] => pair[0] !== null && Boolean(pair[1]))
    db.putCache(key, pairs, 30 * 24 * 60 * 60 * 1000)
    return new Map(pairs)
  } catch (error) {
    logError('catalog:tmdb:genres', error)
    return new Map()
  }
}

/**
 * TMDB's own "if you liked this, try these" for one IMDb id — the
 * genre/style/audience-overlap notion of similar, which is what the panel
 * is actually asking for.
 *
 * Two endpoints supply the pool — /recommendations (behavioural, the
 * better list, but sparse on obscure titles) and /similar (keyword- and
 * genre-driven, noisier, but it always has something) — and the pool is
 * then re-ranked here by genre agreement rather than trusting either
 * endpoint's own order.
 *
 * Franchise instalments are subtracted using the collection this title
 * belongs to — the exact lookup that USED to be the whole answer here,
 * now doing the opposite job. TMDB happily recommends "John Wick: Chapter
 * 4" to someone looking at "John Wick", and that is precisely the result
 * this panel is not for.
 *
 * Returns `[]` (never throws) when TMDB isn't connected, the title can't
 * be found, or anything fails — the caller falls back to local ranking.
 */
async function tmdbSimilar(kind: 'movie' | 'series', imdbId: string): Promise<CatalogItem[]> {
  const { apiKey } = tmdbCredentials()
  if (!apiKey) return []
  const path = kind === 'series' ? 'tv' : 'movie'
  const auth = `api_key=${encodeURIComponent(apiKey)}`

  try {
    const found = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?${auth}&external_source=imdb_id`
    )
    const results = kind === 'series' ? found.tv_results : found.movie_results
    const sourceId = tmdbId(results?.[0]?.id)
    if (!sourceId) return []

    // Franchise siblings to subtract. Movies only — TMDB models
    // collections for films, and a tv show's "franchise" has no equivalent
    // field, so there's nothing to look up for series.
    const excluded = new Set<number>([sourceId])
    if (kind === 'movie') {
      try {
        const detail = await fetchJson<RawApiPayload>(
          `https://api.themoviedb.org/3/movie/${sourceId}?${auth}`
        )
        const collectionId = tmdbId(detail.belongs_to_collection?.id)
        if (collectionId) {
          const collection = await fetchJson<RawApiPayload>(
            `https://api.themoviedb.org/3/collection/${collectionId}?${auth}`
          )
          for (const part of collection.parts || []) {
            const id = tmdbId(part.id)
            if (id) excluded.add(id)
          }
        }
      } catch (error) {
        // A missing exclusion list degrades the result, it doesn't
        // invalidate it — the title heuristic below still catches the
        // obvious instalments.
        logError('catalog:similar:collection', error)
      }
    }

    const [recommended, alike] = await Promise.all([
      fetchJson<RawApiPayload>(
        `https://api.themoviedb.org/3/${path}/${sourceId}/recommendations?${auth}`
      ).catch(() => ({}) as RawApiPayload),
      fetchJson<RawApiPayload>(
        `https://api.themoviedb.org/3/${path}/${sourceId}/similar?${auth}`
      ).catch(() => ({}) as RawApiPayload)
    ])

    const genreNames = await tmdbGenreNames(apiKey, path)
    const namedGenres = (record: RawApiPayload): string[] =>
      (record.genre_ids || [])
        .map((g: unknown) => genreNames.get(Number(g)))
        .filter((x: string | undefined): x is string => Boolean(x))

    // TMDB provides the candidate POOL; this app's own criterion decides
    // the ORDER. /recommendations is behavioural ("people who watched this
    // also watched"), which is a good pool but pulls toward the same
    // universe and the same stars rather than the same kind of film;
    // /similar is keyword- and genre-driven but noisier. Merged and then
    // re-ranked by genre agreement, they answer the question actually
    // being asked — same sort of thing — using the identical scorer the
    // no-API-key path uses, so both paths agree on what "similar" means.
    // Ranking here also means the external-id lookups below are spent on
    // the twelve titles that will actually be shown.
    const source = results?.[0] ?? {}
    const sourceTitle = String(source.title || source.name || source.original_title || '')
    const seen = new Set<string>()
    const pool: CatalogItem[] = []
    for (const record of [...(recommended.results || []), ...(alike.results || [])]) {
      const id = tmdbId(record.id)
      const key = `tmdb:${id}`
      if (!id || excluded.has(id) || seen.has(key)) continue
      // Belt to the collection's braces: a franchise whose instalments TMDB
      // never grouped into a collection (and every tv show, which has no
      // collection concept at all) is only caught by the title.
      if (sourceTitle && isLikelyFranchiseSibling(sourceTitle, String(record.title || record.name)))
        continue
      seen.add(key)
      pool.push(normalizeTmdbTitle(record, key, kind, namedGenres(record)))
    }
    if (!pool.length) return []

    const ranked = rankSimilarTitles(
      {
        id: `tmdb:${sourceId}`,
        title: sourceTitle,
        genres: namedGenres(source),
        year: String((kind === 'series' ? source.first_air_date : source.release_date) || '').slice(
          0,
          4
        )
      },
      pool,
      SIMILAR_LIMIT
    )
    // No genre signal to rank by (a title TMDB has no genres for) — the
    // merged pool is still a real answer, so fall back to its own order
    // rather than showing nothing.
    const chosen = ranked.length ? ranked : pool.slice(0, SIMILAR_LIMIT)

    // One external-ids request each, concurrently. A candidate with no
    // IMDb id is dropped rather than shown: every route, artwork lookup
    // and stream search in this app is IMDb-keyed, so it would open a
    // detail page that can't resolve anything.
    return (
      await Promise.all(
        chosen.map(async (item): Promise<CatalogItem | null> => {
          try {
            const id = tmdbId(item.id.replace('tmdb:', ''))
            if (!id) return null
            const external = await fetchJson<RawApiPayload>(
              `https://api.themoviedb.org/3/${path}/${id}/external_ids?${auth}`
            )
            if (!external.imdb_id) return null
            return { ...item, id: String(external.imdb_id) }
          } catch {
            return null
          }
        })
      )
    ).filter((x): x is CatalogItem => Boolean(x))
  } catch (error) {
    logError('catalog:similar:tmdb', error)
    return []
  }
}

/**
 * Similar titles ranked out of this app's OWN cached catalog, by genre
 * overlap (see rankSimilarTitles). No API key, no network — which is the
 * point: TMDB is optional in this app, and before this the whole panel
 * was dead without it.
 *
 * The pool is whatever the browse catalog already holds for this kind, so
 * the suggestions are titles the person can actually open and play, not
 * ones this app has no catalog entry for.
 */
async function localSimilar(
  kind: MediaKind,
  id: string,
  exclude: Set<string> = new Set()
): Promise<CatalogItem[]> {
  const db = getDatabase()
  const pool = db.getCache<CatalogItem[]>(`catalog:v2:${kind}`, { allowExpired: true }) || []
  if (!pool.length) return []
  // The catalog entry first — it's already in hand. metadata() is the
  // fallback for a title reached from search or a party suggestion, which
  // never passed through the browse catalog; it's itself cached 24h.
  let source = pool.find((item) => item.id === id) || null
  if (!source) {
    try {
      source = await metadata(kind, id)
    } catch (error) {
      logError('catalog:similar:meta', error)
      return []
    }
  }
  const candidates = exclude.size ? pool.filter((item) => !exclude.has(item.id)) : pool
  return rankSimilarTitles(source, candidates, SIMILAR_LIMIT)
}

/**
 * Cached (7d) similar titles for one catalog id: TMDB's recommendations
 * when TMDB is connected, otherwise (or when TMDB has nothing) a
 * genre-ranked pull from the local catalog. Falls back to a stale cache
 * entry rather than failing the caller, matching relatedAnime above.
 *
 * Anime skips TMDB entirely — Kitsu ids have no IMDb mapping anywhere in
 * this app (see metadata()'s own gating), so there's nothing to look a
 * TMDB record up by. Kitsu's genre/category titles are already on the
 * catalog entry, so local ranking works for anime unchanged — and Kitsu's
 * franchise relationship graph (relatedAnime, which is what this rail
 * used to show outright) becomes the exclusion list, exactly the job
 * TMDB's collection does on the movie path above. A sequel is not a
 * suggestion.
 */
async function similarTitles(kind: MediaKind, id: string): Promise<CatalogItem[]> {
  const key = `similar:v1:${kind}:${id}`
  const db = getDatabase()
  const cached = db.getCache<CatalogItem[]>(key)
  if (cached) return cached

  try {
    const remote = kind === 'anime' ? [] : await tmdbSimilar(kind, id)
    const exclude =
      kind === 'anime'
        ? new Set((await relatedAnime(id)).map((item) => item.id).filter(Boolean))
        : new Set<string>()
    const result = remote.length ? remote : await localSimilar(kind, id, exclude)
    // A real answer is stable for a week. An empty one usually isn't a
    // fact about the title — it's a catalog that hadn't been fetched yet,
    // or TMDB having a bad moment — so it gets a short TTL instead of
    // being locked in for seven days. Still cached, so a genuinely
    // suggestion-less title doesn't re-run the whole lookup on every
    // visit the way the old code did.
    db.putCache(key, result, result.length ? 7 * 24 * 60 * 60 * 1000 : 60 * 60 * 1000)
    return result
  } catch (error) {
    logError('catalog:similar', error)
    return db.getCache<CatalogItem[]>(key, { allowExpired: true }) || []
  }
}

interface CatalogListPayload {
  kind?: unknown
  force?: unknown
}

interface CatalogMetaPayload {
  type: MediaKind
  id: string
}

interface CatalogSearchPayload {
  kind?: unknown
  query?: unknown
}

interface CatalogRelatedPayload {
  type: MediaKind
  id: string
}

/** Registers catalog:list/meta/search/related and tmdb:connect/disconnect. */
export function registerCatalogIpc(): void {
  handle<CatalogListPayload, CatalogItem[]>(MEDIA_HUB_CHANNELS.catalogList, async (_e, payload) => {
    const kind = payload?.kind
    const force = payload?.force === true
    if (!isValidCatalogKind(kind)) throw new Error('Unsupported catalog.')
    return catalogData(kind, force)
  })

  handle<CatalogMetaPayload, CatalogItem>(
    MEDIA_HUB_CHANNELS.catalogMeta,
    async (_e, { type, id }) => metadata(type, id)
  )

  handle<CatalogSearchPayload, CatalogItem[]>(
    MEDIA_HUB_CHANNELS.catalogSearch,
    async (_e, { kind, query }) => {
      if (!isValidCatalogKind(kind)) throw new Error('Unsupported catalog.')
      const q = String(query || '').trim()
      if (q.length < 2) return []
      return kind === 'anime' ? kitsuSearch(q) : simklSearch(kind, q)
    }
  )

  handle<CatalogRelatedPayload, CatalogItem[]>(
    MEDIA_HUB_CHANNELS.catalogRelated,
    async (_e, { type, id }) => {
      if (!isValidCatalogKind(type)) return []
      return similarTitles(type, id)
    }
  )

  handle<string, ConnectResult>(MEDIA_HUB_CHANNELS.tmdbConnect, async (_e, raw) => {
    const value = String(raw || '').trim()
    if (!value) return { ok: false, message: 'Enter a TMDB API key.' }
    try {
      const result = await fetchJson<{ success?: boolean }>(
        `https://api.themoviedb.org/3/authentication?api_key=${encodeURIComponent(value)}`
      )
      if (!result.success) return { ok: false, message: 'That TMDB API key was rejected.' }
      const s = readSettings()
      s.tmdbApiKey = encrypt(value)
      writeSettings(s)
      return { ok: true, message: 'TMDB connected.' }
    } catch (error) {
      return { ok: false, message: (error as Error).message }
    }
  })

  handle<undefined, ConnectResult>(MEDIA_HUB_CHANNELS.tmdbDisconnect, () => {
    const s = readSettings()
    delete s.tmdbApiKey
    writeSettings(s)
    return { ok: true }
  })
}
