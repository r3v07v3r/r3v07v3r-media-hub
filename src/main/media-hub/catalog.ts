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

import type {
  CatalogItem,
  CatalogListing,
  ConnectResult,
  Episode,
  MediaKind,
  PersonCreditsResult,
  TitleCollectionResult,
  WatchProvidersResult
} from '../../shared/media-hub/types'
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
  mergeCatalogSources,
  normalizeKitsuAnime,
  normalizeMeta,
  normalizeSimklCatalog,
  normalizeSimklSearchResult,
  normalizeTmdbTitle,
  type RawApiPayload
} from './core'
import { isLikelyFranchiseSibling, rankSimilarTitles } from '../../shared/media-hub/catalog-logic'
import { coalesce, coalesceScope, mapWithLimit, type TaskPriority } from './taskScheduler'
import {
  buildGroupedAnimeVideos,
  groupAnimeCatalog,
  groupedIdsFor,
  invalidateAnimeGroupIndex,
  kitsuRealEpisodes
} from './animeSeasons'
import { omdbRottenTomatoesRating } from './omdb'
import { searchCredits, titleCredits, titlesFeaturing } from './credits'
import { titleCollection } from './collection'
import { contentRating } from './contentRating'
import { watchProviders, watchRegion } from './watchProviders'

const catalogUrls: Record<'movie' | 'series', string> = {
  movie: 'https://v3-cinemeta.strem.io/catalog/movie/top.json',
  series: 'https://v3-cinemeta.strem.io/catalog/series/top.json'
}

/**
 * Simkl's trending feeds, newest window first. Confirmed live: these three
 * spans are all that exist (`year` and `all` are 404s), each returns
 * exactly 500 entries, and the pages overlap heavily — week and month
 * together dedupe to 559 unique movies, which is the whole movie library
 * this app used to have and is why it felt small. Adding `today` takes
 * that to 669; there is no fourth feed to add.
 */
const SIMKL_TRENDING_SPANS = ['today', 'week', 'month'] as const

/**
 * How many 100-entry pages of Cinemeta's top catalog to walk per kind,
 * beyond the first.
 *
 * This is the source that actually makes the library big: Simkl's own
 * feeds are capped at the ~600 unique titles above no matter how they are
 * combined. Cinemeta is Stremio's catalog addon and is already this app's
 * metadata source for every movie and series, so nothing new is being
 * depended on — only more of what is already there, via the addon
 * protocol's `skip=` pagination.
 *
 * Every page is fetched independently and a failed page contributes
 * nothing rather than failing the catalog (see cinemetaPages). That
 * matters beyond ordinary robustness: it means the worst case for this
 * whole expansion is the library staying exactly the size it is today.
 */
const CINEMETA_EXTRA_PAGES = 12
const CINEMETA_PAGE_SIZE = 100

const CATALOG_TTL_MS = 6 * 60 * 60 * 1000

/**
 * Marks that the anime catalog currently in cache has been through the
 * franchise-grouping pass.
 *
 * Needed because the pass takes minutes and the raw catalog is cached
 * before it starts. Quit in between — closing the app during a crawl is
 * hardly exotic — and the next launch finds a perfectly valid six-hour
 * cache entry, returns it without ever reaching the grouping call, and
 * shows one tile per season for every multi-season franchise until that
 * entry expires. The hourly refresh honours the same cache, so it does
 * not rescue it either.
 *
 * A marker rather than inspecting the catalog for groupedIds: "no item
 * has any siblings" is indistinguishable from "never grouped" by
 * inspection, and guessing wrong there means re-running the largest
 * background job in the app on every cache hit, forever.
 */
const ANIME_GROUPED_KEY = 'catalog:v2:anime:grouped'

/**
 * How deep into Kitsu's popularity ranking the anime crawl walks, in
 * titles. Pages are 20 each, so this is 100 requests.
 *
 * This was 1000, set when the crawl paced itself with a sleep between
 * every batch of five and ran on the response path of catalog:list — at
 * which point going deeper meant a longer wait for the person who opened
 * the app. Neither is true now: the pages are paced by the kitsu lane
 * alongside every other Kitsu caller, and the six-hourly refresh job
 * (backgroundJobs.ts) fetches them at `maintenance` before the cache
 * expires, so depth costs background time rather than anyone's page load.
 */
const ANIME_CATALOG_DEPTH = 2000

/**
 * Which raw anime catalog is current. Bumped every time one is written, so
 * a grouping pass can tell whether the catalog it started from is still
 * the one on disk by the time it finishes — see startAnimeGrouping.
 */
let animeCatalogGeneration = 0
/** The in-flight grouping pass, and the catalog it is grouping. */
let animeGrouping: { generation: number; promise: Promise<unknown> } | null = null
/** A catalog that arrived while a pass was already running, waiting for
 *  its own turn. Only the newest is worth keeping. */
let animeGroupingPending: CatalogItem[] | null = null

/**
 * Grouping the full Kitsu crawl costs roughly one enrichment request per
 * title, plus a second relationship pass for every title without a TVDB
 * mapping. That is valuable catalog hygiene and it is also the single
 * largest piece of background work this app does, so it runs at
 * `maintenance` — the tier that stands down for anything anyone is
 * waiting on, and that is suspended outright during playback.
 *
 * It no longer needs a timer of its own to stay off the critical path.
 * The tier is what keeps it off now: catalog:list's own requests outrank
 * it, so it simply is not dispatched until they are done. A fixed 15s
 * delay could only ever guess at when that moment was.
 *
 * Deliberately NOT coalesce(): a pass takes minutes, and a refresh that
 * lands inside one wants its OWN items grouped, not a share of the result
 * of grouping the previous catalog. Joining would have been worse than a
 * wasted request — the joining caller would then write that older,
 * already-superseded result straight over the newer catalog it had just
 * cached. So a second caller waits its turn instead, and the write is
 * guarded by the generation it started from either way.
 */
function startAnimeGrouping(items: CatalogItem[]): void {
  if (items.length < 2) return
  const generation = ++animeCatalogGeneration
  if (animeGrouping) {
    // A pass is already running against an older catalog. Starting a
    // second full enrichment pass alongside it would double the largest
    // piece of background work in the app; queue this one instead. Only
    // the newest waiting catalog is worth keeping.
    animeGroupingPending = items
    return
  }
  runAnimeGrouping(items, generation)
}

function runAnimeGrouping(items: CatalogItem[], generation: number): void {
  const promise = groupAnimeCatalog(items, 'maintenance')
    .then((grouped) => {
      // The ungrouped catalog is already cached and usable. Replacing it
      // only after the whole enrichment pass succeeds avoids ever leaving
      // a partial catalog in the cache.
      //
      // And only if it is still the same catalog: a refresh may have
      // landed during the minutes this took, in which case what is on
      // disk is NEWER than what was just grouped, and writing this would
      // silently roll it back.
      if (!grouped.length || generation !== animeCatalogGeneration) return
      getDatabase().putCache('catalog:v2:anime', grouped, CATALOG_TTL_MS)
      getDatabase().putCache(ANIME_GROUPED_KEY, true, CATALOG_TTL_MS)
      // The whole point of the pass that just finished is the groupedIds
      // it worked out, so the index has to drop the pre-grouping answer
      // it may have already handed out.
      invalidateAnimeGroupIndex()
    })
    .catch((error) => logError('catalog:anime-grouping', error))
    .finally(() => {
      animeGrouping = null
      const next = animeGroupingPending
      animeGroupingPending = null
      // Whatever arrived while this was running still needs grouping —
      // without this it would stay ungrouped until the next refresh
      // hours later, with every multi-season franchise showing one tile
      // per season in the meantime.
      if (next) runAnimeGrouping(next, animeCatalogGeneration)
    })
  animeGrouping = { generation, promise }
}

// groupedIdsFor/invalidateAnimeGroupIndex (which franchise siblings each
// crawled anime has, by catalog id, and the cache-invalidation hook the
// grouping pass and catalogData use) now live in animeSeasons.ts alongside
// resolveAnimeGroupTarget, the inverse lookup every tracker sync (MAL,
// Trakt, Simkl) needs — see that module for the full doc.

/** Cached (7d) Kitsu genre/category titles for one anime id. */
async function kitsuCategories(id: string, priority: TaskPriority): Promise<string[]> {
  const key = `kitsu:categories:${id}`
  const db = getDatabase()
  const cached = db.getCache<string[]>(key)
  if (cached) return cached

  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime/${encodeURIComponent(id)}/categories?page%5Blimit%5D=20`,
    {},
    { priority, label: 'anime genres' }
  )
  const genres: string[] = (result.data || [])
    .map((x: RawApiPayload) => x.attributes?.title)
    .filter(Boolean)
  db.putCache(key, genres, 7 * 24 * 60 * 60 * 1000)
  return genres
}

/** Merges Simkl's week/month trending feeds for one section into a deduped catalog, dropping unmatched (no-imdb) entries. */
async function simklCatalog(
  kind: Exclude<MediaKind, 'anime'>,
  priority: TaskPriority
): Promise<CatalogItem[]> {
  const section = kind === 'series' ? 'tv' : 'movies'
  const feeds = await Promise.all(
    SIMKL_TRENDING_SPANS.map((span) =>
      fetchJson<RawApiPayload[]>(
        `https://data.simkl.in/discover/trending/${section}/${span}_500.json`,
        {},
        { priority, label: `${kind} trending (${span})` }
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

/**
 * Cinemeta's top catalog for one kind, walked `CINEMETA_EXTRA_PAGES` pages
 * deep via the Stremio addon protocol's `skip=` pagination.
 *
 * Page 0 is deliberately the exact URL this file has always used as its
 * Simkl-failed fallback (catalogUrls), not a `skip=0` variant of it — so
 * the one request whose shape is already proven in production stays
 * byte-identical, and only the additional pages use the paginated form.
 *
 * Every page resolves independently to `[]` on failure. A page shape this
 * app has never asked for before must not be able to take down a catalog
 * that Simkl has already successfully filled.
 */
async function cinemetaPages(
  kind: Exclude<MediaKind, 'anime'>,
  priority: TaskPriority
): Promise<CatalogItem[][]> {
  const urls = [catalogUrls[kind]]
  for (let page = 1; page <= CINEMETA_EXTRA_PAGES; page++) {
    urls.push(
      `https://v3-cinemeta.strem.io/catalog/${kind}/top/skip=${page * CINEMETA_PAGE_SIZE}.json`
    )
  }
  return Promise.all(
    urls.map(async (url, index) => {
      try {
        const result = await fetchJson<{ metas?: RawApiPayload[] }>(
          url,
          {},
          { priority, label: `${kind} catalog (page ${index + 1})` }
        )
        return (result.metas || []).map((x) => normalizeMeta(x, kind))
      } catch {
        return []
      }
    })
  )
}

/**
 * The TMDB lists this app pulls into the catalog, per kind.
 *
 * Not the same list for both: TMDB has no "upcoming" endpoint for TV — its
 * whole now-playing/upcoming distinction is a movie-release-window concept
 * that a show's episodic schedule doesn't map onto — so a series catalog
 * asking for one would be shipping a made-up answer rather than an absent
 * one. `on_the_air` (currently airing) is the honest analogue.
 */
const TMDB_CURATED_LISTS: Record<'movie' | 'series', string[]> = {
  movie: ['now_playing', 'upcoming', 'top_rated'],
  series: ['on_the_air', 'top_rated']
}

/** How many pages of each TMDB list to pull, and the id-resolution cost that
 *  bounds it: every item pulled costs one `external_ids` request below, so
 *  three lists at two pages of twenty is up to 120 of those per catalog
 *  build — real, but background-priority and six-hourly, the same terms
 *  the rest of this crawl already runs on. */
const TMDB_CURATED_PAGES = 2

/**
 * How long tmdbCuratedCatalog is allowed before it stops contributing to
 * THIS build.
 *
 * Up to 120 external-id lookups is not free, and catalogListing's merge is
 * on the response path of a cold `catalog:list` — the same "one slow
 * background computation stalls the thing somebody is looking at" failure
 * this app has hit before (see recommendations.ts's own account of an
 * 87.7-SECOND launch-path stall from a similarly unbounded pass). A source
 * that misses this window contributes nothing to this build and is tried
 * again on the next one; it never holds up Simkl or Cinemeta's own results.
 */
const TMDB_CURATED_TIMEOUT_MS = 6000

/**
 * TMDB's own curated lists — now playing, upcoming, top rated — merged into
 * the SAME catalog Simkl and Cinemeta build, rather than surfaced as a
 * separate browse surface.
 *
 * That choice is deliberate. Simkl's trending feeds and Cinemeta's "top"
 * catalog are both, in the end, popularity rankings of roughly the same
 * pool — which is exactly the "same twenty titles" complaint this exists to
 * fix. TMDB's now-playing and upcoming lists are ranked by RELEASE WINDOW
 * instead, so they reliably surface titles the other two sources have not
 * caught up to yet. Feeding that pool into the one place every browse sort,
 * search and recommendation already reads from means the fix reaches all
 * of them at once, for free — no new page, no new row, no new thing to
 * maintain in sync with the real catalog.
 *
 * Silent and additive on every possible failure, matching Cinemeta's own
 * pages above: no TMDB key connected, a list request failing, or an
 * id that never resolves to an IMDb one all just contribute nothing. The
 * worst case is this catalog staying exactly the size it was before TMDB
 * was added, never smaller.
 */
async function tmdbCuratedCatalog(
  kind: Exclude<MediaKind, 'anime'>,
  priority: TaskPriority
): Promise<CatalogItem[]> {
  const { apiKey } = tmdbCredentials()
  if (!apiKey) return []
  const auth = `api_key=${encodeURIComponent(apiKey)}`
  const path = kind === 'series' ? 'tv' : 'movie'
  const region = watchRegion()

  const genreNames = await tmdbGenreNames(apiKey, path)
  const namedGenres = (record: RawApiPayload): string[] =>
    (record.genre_ids || [])
      .map((g: unknown) => genreNames.get(Number(g)))
      .filter((x: string | undefined): x is string => Boolean(x))

  const lists = TMDB_CURATED_LISTS[kind]
  const pages = await Promise.all(
    lists.flatMap((list) =>
      Array.from({ length: TMDB_CURATED_PAGES }, (_unused, index) =>
        fetchJson<RawApiPayload>(
          `https://api.themoviedb.org/3/${path}/${list}?${auth}&region=${encodeURIComponent(region)}&page=${index + 1}`,
          {},
          { priority, label: `${kind} ${list} (page ${index + 1})` }
        )
          .then((result) => result.results || [])
          .catch(() => [] as RawApiPayload[])
      )
    )
  )

  // Deduped by TMDB id BEFORE resolution, since the same title routinely
  // appears on more than one of these lists (a top-rated film that is also
  // still in theatres) — resolving it twice would spend two requests to
  // learn the same IMDb id.
  const seen = new Set<number>()
  const candidates: { id: number; record: RawApiPayload }[] = []
  for (const record of pages.flat()) {
    const id = tmdbId(record.id)
    if (!id || seen.has(id)) continue
    seen.add(id)
    candidates.push({ id, record })
  }

  // One external-ids request each, bounded — see TMDB_CURATED_PAGES. A
  // candidate with no IMDb id is dropped: every route, artwork lookup and
  // stream search in this app is IMDb-keyed, so keeping it would put an
  // unopenable tile in the grid.
  const resolved = await mapWithLimit(candidates, async ({ id, record }) => {
    const external = await fetchJson<RawApiPayload>(
      `https://api.themoviedb.org/3/${path}/${id}/external_ids?${auth}`,
      {},
      { priority, label: `${kind} curated external id` }
    )
    const imdbId = String(external.imdb_id || '')
    if (!/^tt\d+$/.test(imdbId)) return null
    return normalizeTmdbTitle(record, imdbId, kind, namedGenres(record))
  })
  return resolved.filter((item): item is CatalogItem => Boolean(item))
}

/** One page (20 items) of Kitsu's most-popular-anime listing, with genre titles resolved from the included `categories` sideload. */
async function kitsuPage(offset: number, priority: TaskPriority): Promise<CatalogItem[]> {
  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime?sort=-userCount&page%5Blimit%5D=20&page%5Boffset%5D=${offset}&include=categories`,
    {},
    { priority, label: `anime catalog +${offset}` }
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

/**
 * Walks Kitsu's popularity ranking, 20 entries per page.
 *
 * Every page is asked for at once and the scheduler's kitsu lane decides
 * how fast they actually go out — which is why the hand-rolled "five at a
 * time, then sleep 350ms" batching this used to do is gone. That loop
 * paced this one crawl against nothing but itself: it had no idea whether
 * anything else in the app was talking to Kitsu at the same moment (the
 * franchise-grouping pass and every open anime detail page are), and it
 * made the crawl's own progress hostage to the slowest page in each batch
 * of five. The lane's gap is the same politeness, applied across every
 * Kitsu caller at once instead of to this one in isolation.
 */
async function kitsuCatalog(priority: TaskPriority): Promise<CatalogItem[]> {
  const offsets: number[] = []
  for (let offset = 0; offset < ANIME_CATALOG_DEPTH; offset += 20) offsets.push(offset)
  const pages = await Promise.all(offsets.map((offset) => kitsuPage(offset, priority)))
  // Kitsu has no franchise concept — each season/cour is its own top-level
  // entry. The exhaustive franchise pass is deliberately left to run after
  // this result is returned (see startAnimeGrouping) rather than awaited
  // here: this function is on the response path of the renderer's
  // catalog:list request as well as the six-hourly refresh job's, and
  // that pass takes minutes.
  return dedupeCatalog(pages)
}

/**
 * The cached top-level catalog for one kind (movie/series/anime).
 *
 * Anime comes from Kitsu. Movies and series are read from Simkl's
 * trending feeds AND Cinemeta's top catalog together and merged — see
 * mergeCatalogSources, and SIMKL_TRENDING_SPANS for why one source is not
 * enough. A source that fails costs its own contribution and nothing
 * else, which preserves what the old try-Simkl-then-fall-back-to-Cinemeta
 * chain gave: either one alone still fills the catalog.
 *
 * If nothing is left after all that, falls back to a stale cache entry
 * (even if expired) before finally rethrowing the original error.
 */
export async function catalogData(
  kind: MediaKind,
  force = false,
  priority: TaskPriority = 'visible'
): Promise<CatalogItem[]> {
  return (await catalogListing(kind, force, priority)).items
}

/**
 * catalogData, plus whether anything actually fetched the rows.
 *
 * Same work, same coalescing — the only difference is that the
 * expired-cache fallback is reported rather than passed off as a fetch.
 * A caller that cannot tell the two apart shows stale rows with no
 * warning and, if it dates what it stores, renews them indefinitely; see
 * CatalogListing. catalogData stays the plain-items form for the callers
 * that only want a catalog to rank over.
 */
export async function catalogListing(
  kind: MediaKind,
  force = false,
  priority: TaskPriority = 'visible'
): Promise<CatalogListing> {
  if (!['movie', 'series', 'anime'].includes(kind)) throw new Error('Unknown catalog.')
  const key = `catalog:v2:${kind}`
  const db = getDatabase()
  if (!force) {
    const cached = db.getCache<CatalogItem[]>(key)
    if (cached) {
      // A cached anime catalog that never finished being grouped — the
      // app was closed mid-pass — gets picked up here rather than waiting
      // out its six hours ungrouped. See ANIME_GROUPED_KEY.
      if (kind === 'anime' && db.getCache<boolean>(ANIME_GROUPED_KEY) !== true) {
        startAnimeGrouping(cached)
      }
      // A cache entry inside its TTL is current by definition — this is
      // the ordinary hit, not the expired fallback below.
      return { items: cached, stale: false }
    }
  }

  // Coalesced across callers, which matters more here than anywhere else
  // in the app: on a cold start the renderer fires catalog:list for all
  // three kinds AND home:personalized (which asks for all three itself)
  // within a few milliseconds of each other. Before this, that was two
  // full Kitsu crawls running side by side, each writing its result over
  // the other's, for one catalog nobody asked for twice.
  //
  // `force` is part of the key so an explicit refresh is never satisfied
  // by joining an ordinary in-flight fetch that is about to return the
  // cached-source result the person just asked to bypass. The fg/bg scope
  // keeps a person's refresh from joining the six-hourly maintenance
  // crawl and inheriting its tier — see coalesceScope. The two callers
  // that actually matter here, catalog:list and home:personalized, are
  // both foreground and both unforced, so they still share one crawl.
  const scope = coalesceScope(priority)
  return coalesce(`catalog:fetch:${kind}:${force ? 'forced' : 'normal'}:${scope}`, async () => {
    let items: CatalogItem[] | null | undefined
    let primaryError: unknown = new Error('The broad catalog returned no titles.')

    if (kind === 'anime') {
      try {
        items = await kitsuCatalog(priority)
      } catch (error) {
        primaryError = error
        items = null
      }
    } else {
      // Both sources, merged — not "Simkl, and Cinemeta only if Simkl
      // failed", which is what this used to be. Simkl's trending feeds
      // cap out at around 600 unique titles however they are combined
      // (see SIMKL_TRENDING_SPANS), so treating Cinemeta as a
      // failure-only fallback was leaving the app's own metadata source
      // unread for browsing purposes and the library that size.
      //
      // Simkl first, because dedupeCatalog keeps the first occurrence of
      // an id and trending order is the more useful ranking for what
      // appears at the top of a grid. Cinemeta's depth follows it.
      //
      // Settled rather than awaited together, so one source being down
      // costs its own contribution and nothing else — which also
      // preserves the old fallback guarantee exactly: a total Simkl
      // failure still yields a Cinemeta-filled catalog.
      const settled = await Promise.allSettled([
        simklCatalog(kind, priority).then((list) => [list]),
        cinemetaPages(kind, priority),
        // Last, deliberately — see tmdbCuratedCatalog. Simkl and Cinemeta
        // already fill the bulk of the catalog and set the ranking that
        // matters (dedupeCatalog keeps the FIRST occurrence of an id), so
        // this only ever ADDS what they missed rather than reordering
        // anything they already found. Raced against its own timeout so a
        // slow resolution pass can never make Simkl and Cinemeta's own
        // results wait for it — see TMDB_CURATED_TIMEOUT_MS.
        Promise.race([
          tmdbCuratedCatalog(kind, priority),
          new Promise<CatalogItem[]>((resolve) =>
            setTimeout(() => resolve([]), TMDB_CURATED_TIMEOUT_MS)
          )
        ]).then((list) => [list])
      ])
      if (settled[0].status === 'rejected') primaryError = settled[0].reason
      items = mergeCatalogSources(settled)
    }

    if (!items?.length) {
      const stale = db.getCache<CatalogItem[]>(key, { allowExpired: true })
      // Reported as stale, not returned as a fetch. These rows have no
      // established age beyond "whatever they were before", so a caller
      // that stamps what it stores must not stamp them with now.
      if (stale?.length) return { items: stale, stale: true }
      throw primaryError
    }

    db.putCache(key, items, CATALOG_TTL_MS)
    if (kind === 'anime') {
      // This catalog is raw until the pass below says otherwise. Written
      // rather than left absent so a marker from the PREVIOUS catalog
      // cannot vouch for this one.
      db.putCache(ANIME_GROUPED_KEY, false, CATALOG_TTL_MS)
      invalidateAnimeGroupIndex()
      startAnimeGrouping(items)
    }
    return { items, stale: false }
  })
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
async function resolveSimklId(
  type: MediaKind,
  simklId: string,
  priority: TaskPriority
): Promise<string> {
  const endpointType = type === 'series' ? 'tv' : 'movies'
  const result = await simklPublicRequest<RawApiPayload>(
    `/${endpointType}/${encodeURIComponent(simklId)}?extended=full`,
    priority
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
export function metadata(
  type: MediaKind,
  id: string,
  priority: TaskPriority = 'interactive'
): Promise<CatalogItem> {
  // Coalesced per title. tracking:list and home:personalized each resolve
  // metadata for every tracked series, and the renderer calls both at
  // once on every launch — without this, every tracked title is fetched
  // exactly twice, in parallel, for two identical answers. Both are
  // foreground, so they share.
  //
  // Scoped, so opening a detail page can never join the reconcile pass's
  // background fetch for the same title and end up waiting behind its own
  // page's requests — see coalesceScope.
  return coalesce(`meta:${type}:${id}:${coalesceScope(priority)}`, () =>
    resolveMetadata(type, id, priority)
  )
}

/**
 * Attaches cast, creators and story-type labels to a resolved item.
 *
 * Applied on the way OUT of resolveMetadata, to the cache-hit path as well
 * as the fresh-fetch one, and deliberately not written into the metadata
 * cache. Two reasons, and they are the same two that make
 * disambiguateVideos re-run on cached entries above:
 *
 *  - a 24h metadata entry written before credits existed would otherwise
 *    serve a title with no cast until it expired, which is most titles for
 *    the first day after this ships;
 *  - credits have their own rows and their own ninety-day clock (see
 *    credits.ts). Copying them into a second cache with a different TTL
 *    means two answers to the same question that can disagree.
 *
 * Never throws and never blocks the page: titleCredits already reports
 * every failure it has — no TMDB key, an id no source recognises, a failed
 * request — as "no credits for this one".
 */
async function withCredits(
  item: CatalogItem,
  type: MediaKind,
  id: string,
  priority: TaskPriority
): Promise<CatalogItem> {
  const credits = await titleCredits(type, id, priority)
  if (!credits) return item
  return {
    ...item,
    ...(credits.cast.length ? { cast: credits.cast } : {}),
    ...(credits.creators.length ? { creators: credits.creators } : {}),
    ...(credits.keywords.length ? { keywords: credits.keywords } : {})
  }
}

async function resolveMetadata(
  type: MediaKind,
  id: string,
  priority: TaskPriority
): Promise<CatalogItem> {
  const resolvedId = String(id).startsWith('simkl:')
    ? await resolveSimklId(type, String(id).slice(6), priority)
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
  // One exception to serving the cache: an anime whose franchise
  // siblings were worked out AFTER this entry was written.
  //
  // The grouping pass takes minutes, and anything opened while it runs is
  // cached as the single season it looked like at the time. Invalidating
  // the group index when the pass finishes fixes the NEXT lookup of that
  // index, but does nothing for a 24h metadata entry that already
  // answered without it — so the title would keep showing one season, and
  // keep hiding the rest of its franchise, until that entry expired on
  // its own a day later.
  //
  // Checked rather than cleared: enumerating which meta:v3 rows to drop
  // would mean scanning the cache table, and this costs one Map lookup on
  // a path that is already reading from the database. Only titles that
  // actually gained siblings re-resolve, and only once.
  const groupingIsNewer =
    type === 'anime' && !cached?.groupedIds?.length && Boolean(groupedIdsFor(resolvedId)?.length)
  if (cached && !groupingIsNewer) {
    return withCredits(
      { ...cached, videos: disambiguateVideos(cached.videos) },
      type,
      resolvedId,
      priority
    )
  }

  let item: CatalogItem
  try {
    if (type === 'anime') {
      const kitsuId = String(resolvedId)
        .replace(/^kitsu:/, '')
        .split(':')[0]
      const [result, genres] = await Promise.all([
        fetchJson<RawApiPayload>(
          `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}`,
          {},
          { priority, label: 'anime details' }
        ),
        kitsuCategories(kitsuId, priority)
      ])
      item = normalizeKitsuAnime({
        ...result.data,
        attributes: { ...result.data?.attributes, genres }
      })
    } else {
      const result = await fetchJson<{ meta?: RawApiPayload }>(
        `https://v3-cinemeta.strem.io/meta/${type}/${encodeURIComponent(resolvedId)}.json`,
        {},
        { priority, label: `${type} details` }
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
        `https://api.simkl.com/tv/episodes/${encodeURIComponent(String(source.simklId))}`,
        {},
        { priority, label: 'episode list' }
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
    const groupedIds = groupedIdsFor(resolvedId)
    if (groupedIds?.length) item.groupedIds = groupedIds
  }
  if (type === 'anime' && item.groupedIds?.length) {
    try {
      item.videos = await buildGroupedAnimeVideos(item, tmdbCredentials().apiKey, priority)
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
    const real = await kitsuRealEpisodes(kitsuId, item.id, priority)
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
    item.rottenTomatoesRating = await omdbRottenTomatoesRating(String(resolvedId), priority)
  }

  // Applied once here rather than per-source (Cinemeta/Simkl-fallback/
  // grouped-anime all assign item.videos above) — see disambiguateVideos'
  // own doc comment for why this is needed and what it does.
  item.videos = disambiguateVideos(item.videos)

  db.putCache(cacheKey, item, 24 * 60 * 60 * 1000)
  return withCredits(item, type, resolvedId, priority)
}

/** Free-text anime search against Kitsu. Grouped the same way the browse
 *  catalog is (see kitsuCatalog) — a searched multi-season franchise not
 *  popular enough to be in the top-1000 crawl would otherwise show every
 *  season as its own result here regardless of that fix. A search result
 *  set is small (20 items max) so this never needs the crawl's own
 *  candidate-bucket pre-filtering cost concern. */
async function kitsuSearch(query: string): Promise<CatalogItem[]> {
  const result = await fetchJson<RawApiPayload>(
    `https://kitsu.io/api/edge/anime?filter%5Btext%5D=${encodeURIComponent(query)}&page%5Blimit%5D=20`,
    {},
    { priority: 'interactive', label: 'anime search' }
  )
  // 'interactive' throughout, unlike the crawl's own grouping pass: this
  // one is 20 items with somebody watching a search box, not 1000 items
  // nobody asked for.
  return groupAnimeCatalog(
    (result.data || []).map((record) => normalizeKitsuAnime(record, true)),
    'interactive'
  )
}

/** Free-text movie/series search against Simkl. */
async function simklSearch(kind: MediaKind, query: string): Promise<CatalogItem[]> {
  const endpointType = kind === 'series' ? 'tv' : 'movie'
  const result = await simklPublicRequest<RawApiPayload[] | RawApiPayload>(
    `/search/${endpointType}?q=${encodeURIComponent(query)}&extended=full`,
    'interactive'
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
      `https://kitsu.io/api/edge/anime/${encodeURIComponent(kitsuId)}/media-relationships?include=destination&page%5Blimit%5D=20`,
      {},
      { priority: 'interactive', label: 'related anime' }
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
  handle<CatalogListPayload, CatalogListing>(
    MEDIA_HUB_CHANNELS.catalogList,
    async (_e, payload) => {
      const kind = payload?.kind
      const force = payload?.force === true
      if (!isValidCatalogKind(kind)) throw new Error('Unsupported catalog.')
      return catalogListing(kind, force)
    }
  )

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
      const byTitle = kind === 'anime' ? await kitsuSearch(q) : await simklSearch(kind, q)

      // Then the same query against everything already known about each
      // title's cast, creators and story labels. This is what makes typing a
      // director's name find their films rather than only films with their
      // name in the title — the rows are already on disk, so it costs a map
      // lookup rather than a request.
      //
      // AFTER the title matches and never reordering them: somebody typing a
      // title wants that title first, and a cast match is a useful second
      // thought rather than a competing answer.
      const seen = new Set(byTitle.map((item) => String(item.id)))
      const pool = await catalogData(kind, false, 'interactive').catch(() => [] as CatalogItem[])
      const byId = new Map(pool.map((item) => [String(item.id), item]))
      const { people, labels } = searchCredits(byId.keys(), q)
      const extra: CatalogItem[] = []
      for (const id of [...people, ...labels]) {
        if (seen.has(id)) continue
        const item = byId.get(id)
        if (!item) continue
        seen.add(id)
        extra.push(item)
      }
      return [...byTitle, ...extra]
    }
  )

  handle<CatalogRelatedPayload, CatalogItem[]>(
    MEDIA_HUB_CHANNELS.catalogRelated,
    async (_e, { type, id }) => {
      if (!isValidCatalogKind(type)) return []
      return similarTitles(type, id)
    }
  )

  handle<{ person: string }, PersonCreditsResult>(
    MEDIA_HUB_CHANNELS.catalogPerson,
    async (_e, payload) => {
      const person = String(payload?.person ?? '').trim()
      const empty = { person, cast: [], creators: [] }
      if (!person) return empty

      // All three catalogs, from cache only (`false` skips the refresh): this
      // answers a click on a name, and crawling Kitsu for two thousand anime
      // to do it would be a twenty-second wait for a list of four films.
      const pools = await Promise.all(
        (['movie', 'series', 'anime'] as const).map((kind) =>
          catalogData(kind, false, 'interactive').catch(() => [] as CatalogItem[])
        )
      )
      const pool = pools.flat()
      const byId = new Map(pool.map((item) => [String(item.id), item]))
      const { cast, creators } = titlesFeaturing(byId.keys(), person)
      const resolve = (ids: string[]): CatalogItem[] =>
        ids.map((id) => byId.get(id)).filter((item): item is CatalogItem => Boolean(item))
      return { person, cast: resolve(cast), creators: resolve(creators) }
    }
  )

  handle<{ type: MediaKind; id: string }, WatchProvidersResult>(
    MEDIA_HUB_CHANNELS.catalogProviders,
    async (_e, payload) => {
      const type = payload?.type
      if (!isValidCatalogKind(type))
        return { region: watchRegion(), stream: [], rent: [], buy: [], link: '' }
      return watchProviders(type, String(payload?.id ?? ''))
    }
  )

  handle<{ type: MediaKind; id: string }, { rating: string; region: string }>(
    MEDIA_HUB_CHANNELS.catalogRating,
    async (_e, payload) => {
      const type = payload?.type
      if (!isValidCatalogKind(type)) return { rating: '', region: watchRegion() }
      return {
        rating: await contentRating(type, String(payload?.id ?? '')),
        region: watchRegion()
      }
    }
  )

  handle<{ id: string }, TitleCollectionResult>(
    MEDIA_HUB_CHANNELS.catalogCollection,
    async (_e, payload) => titleCollection(String(payload?.id ?? ''))
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
