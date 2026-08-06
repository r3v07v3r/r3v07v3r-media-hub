// Ported from r3v07v3r-media-hub's src/main.cjs — the catalog-domain
// functions (aggregating/caching the Simkl/Kitsu/Cinemeta movie, series and
// anime catalogs, metadata lookup, search, "related titles", and TMDB
// connect/disconnect). Every fallback/cache-staleness path from the
// original is preserved exactly: catalogData's try-primary-source →
// Cinemeta-fallback (non-anime only) → stale-cache → rethrow chain,
// metadata's try-live → stale-catalog-entry (+ Simkl episode refetch for
// series) fallback, and relatedAnime/relatedMovie's try → log → stale-cache
// fallback. Do not simplify or drop any of these branches without
// re-auditing against the source app.

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
  normalizeTmdbCollectionPart,
  type RawApiPayload
} from './core'
import { buildGroupedAnimeVideos, groupAnimeCatalog } from './animeSeasons'

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
    .map(normalizeKitsuAnime)
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
  return groupAnimeCatalog((result.data || []).map(normalizeKitsuAnime))
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

/**
 * Cached (7d) TMDB movie-collection siblings for one IMDb id. Requires a
 * connected TMDB API key (returns `[]`, not an error, when absent — same
 * "no-op when unconfigured" convention as simklWatchedHistory). Resolves
 * IMDb → TMDB movie id → collection id → collection parts, then re-resolves
 * each part back to an IMDb id (dropping parts that fail to resolve) since
 * every other id in this app is IMDb-keyed. Falls back to a stale cache
 * entry (or `[]`) on error rather than failing the caller.
 */
async function relatedMovie(imdbId: string): Promise<CatalogItem[]> {
  const { apiKey } = tmdbCredentials()
  if (!apiKey) return []
  const key = `related:v1:movie:${imdbId}`
  const db = getDatabase()
  const cached = db.getCache<CatalogItem[]>(key)
  if (cached) return cached

  try {
    const found = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`
    )
    const tmdbMovieId = tmdbId(found.movie_results?.[0]?.id)
    if (!tmdbMovieId) return []

    const detail = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/movie/${tmdbMovieId}?api_key=${encodeURIComponent(apiKey)}`
    )
    const collectionId = tmdbId(detail.belongs_to_collection?.id)
    if (!collectionId) return []

    const collection = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/collection/${collectionId}?api_key=${encodeURIComponent(apiKey)}`
    )
    const parts: RawApiPayload[] = (collection.parts || []).filter(
      (p: RawApiPayload) => tmdbId(p.id) && tmdbId(p.id) !== tmdbMovieId
    )

    const resolved = (
      await Promise.all(
        parts.map(async (part): Promise<CatalogItem | null> => {
          try {
            const partId = tmdbId(part.id)
            if (!partId) return null
            const external = await fetchJson<RawApiPayload>(
              `https://api.themoviedb.org/3/movie/${partId}/external_ids?api_key=${encodeURIComponent(apiKey)}`
            )
            return external.imdb_id ? normalizeTmdbCollectionPart(part, external.imdb_id) : null
          } catch {
            return null
          }
        })
      )
    ).filter((x): x is CatalogItem => Boolean(x))

    db.putCache(key, resolved, 7 * 24 * 60 * 60 * 1000)
    return resolved
  } catch (error) {
    logError('catalog:related:movie', error)
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
      if (type === 'anime') return relatedAnime(id)
      if (type === 'movie') return relatedMovie(id)
      return []
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
