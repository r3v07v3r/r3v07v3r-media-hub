// Who made a title, and what kind of story it is.
//
// Until this existed, the only thing the app knew about a title's content
// was its genre list — four or five broad buckets shared by thousands of
// titles. "Do I like this actor", "is this the sort of story I go for" had
// no data behind them at all, at any speed, which is why the ranking could
// only ever work from genre, year and rating.
//
// Two sources, because the catalog is two very different halves and each
// has one that fits it:
//
//   - movie/series carry real IMDb ids, so TMDB answers directly — cast,
//     directors (or a show's creators), and its keyword vocabulary, which
//     is the closest thing to a story-type label a film database has.
//
//   - anime is Kitsu-sourced and has no IMDb id to look up, but this app
//     already caches an AniList id for every crawled title as a side
//     effect of the franchise-grouping pass (see anilist.ts's
//     cacheAnilistIdFromMappings). AniList's tags are better story-type
//     labels than TMDB keywords by some distance — "time loop",
//     "found family", "unrequited love" — and its API is GraphQL, so
//     twenty titles come back in one request rather than twenty.
//
// Stored in their own cache rows rather than on the catalog blob. The
// catalog is a single 3.4MB JSON row parsed on the metadata path; adding
// roughly thirty short strings to each of its 2,776 entries would grow it
// by a third for the benefit of the handful of callers that actually want
// this. A per-title row is read only by whoever needs that title.
//
// Everything here is best-effort. No TMDB key, no AniList id, a title
// TMDB has never heard of, a failed request — all of them mean "no credits
// for this one", never an error. The ranking degrades to what it did
// before, which is exactly what a fresh install sees anyway.

import type { CatalogItem, MediaKind, TitleCredits } from '../../shared/media-hub/types'
import { cachedAnilistId } from './anilist'
import type { RawApiPayload } from './core'
import { getDatabase } from './dbState'
import { fetchJson } from './httpClient'
import { logError } from './logger'
import { tmdbCredentials } from './settingsStore'
import type { TaskPriority } from './taskScheduler'

const EMPTY_CREDITS: TitleCredits = { cast: [], creators: [], keywords: [] }

/**
 * Long, because none of this changes. A film's cast is fixed the day it
 * ships; AniList tags drift only as people vote on them. The cost of a
 * stale entry here is nil, and the cost of refetching four thousand
 * titles on a shorter clock is not.
 */
const CREDITS_TTL_MS = 90 * 24 * 60 * 60 * 1000

/**
 * Cast is capped because billing order is meaningful — the fortieth name
 * on a call sheet says nothing about whether somebody will like a film,
 * and carrying it costs a row of storage per title. Keywords are capped
 * for the same reason: TMDB's tail runs to the incidental ("based on
 * novel", "aftercreditsstinger").
 */
const MAX_CAST = 10
const MAX_CREATORS = 4
const MAX_KEYWORDS = 15

/** AniList takes many ids per GraphQL query — see anilist.ts, which uses the same batch size for the same reason. */
const ANILIST_BATCH_SIZE = 20

function cacheKey(id: string): string {
  return `credits:v1:${id}`
}

function clean(values: unknown, limit: number): string[] {
  if (!Array.isArray(values)) return []
  const out: string[] = []
  const seen = new Set<string>()
  for (const value of values) {
    const name = String(value ?? '').trim()
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    out.push(name)
    if (out.length >= limit) break
  }
  return out
}

/** What has already been looked up for one title. `null` means "not looked up yet", NOT "nothing to find" — see the empty-credits note in fetchCredits. */
export function cachedCredits(id: string): TitleCredits | null {
  try {
    return getDatabase().getCache<TitleCredits>(cacheKey(id), { allowExpired: true })
  } catch {
    return null
  }
}

function storeCredits(id: string, credits: TitleCredits): void {
  try {
    getDatabase().putCache(cacheKey(id), credits, CREDITS_TTL_MS)
  } catch (error) {
    logError('credits:store', error)
  }
}

/**
 * Credits already on disk for a set of titles, skipping the ones that have
 * none yet.
 *
 * Point lookups rather than one big index row: the enrichment pass writes
 * a title at a time and would otherwise have to rewrite a growing index on
 * every one of four thousand titles. Reading a couple of thousand small
 * rows measures in the low hundreds of milliseconds, which is fine where
 * this is called from — the background rebuild — and is why it is not
 * called from anywhere on the launch path.
 */
export function creditsFor(ids: Iterable<string>): Map<string, TitleCredits> {
  const found = new Map<string, TitleCredits>()
  for (const id of ids) {
    const credits = cachedCredits(String(id))
    // An enriched title with nothing to show for it (no TMDB match, no
    // AniList mapping) is stored as empty; carrying it would only make
    // every lookup below check three empty arrays.
    if (credits && (credits.cast.length || credits.creators.length || credits.keywords.length)) {
      found.set(String(id), credits)
    }
  }
  return found
}

/** Resolves an IMDb id to TMDB's own, which every other TMDB endpoint needs. Cached, since it is a fixed fact and this runs thousands of times. */
async function tmdbIdFor(
  kind: 'movie' | 'series',
  imdbId: string,
  apiKey: string,
  priority: TaskPriority
): Promise<number | null> {
  const key = `tmdb:id:${kind}:${imdbId}`
  const db = getDatabase()
  const cached = db.getCache<number>(key)
  if (cached !== null) return cached > 0 ? cached : null

  const found = await fetchJson<RawApiPayload>(
    `https://api.themoviedb.org/3/find/${encodeURIComponent(imdbId)}?api_key=${encodeURIComponent(apiKey)}&external_source=imdb_id`,
    {},
    { priority, label: 'TMDB id lookup' }
  )
  const results = kind === 'series' ? found.tv_results : found.movie_results
  const id = Number(results?.[0]?.id)
  const value = Number.isInteger(id) && id > 0 ? id : -1
  // -1 rather than absence, so a title TMDB genuinely does not have is not
  // re-looked-up on every enrichment pass for the next ninety days.
  db.putCache(key, value, CREDITS_TTL_MS)
  return value > 0 ? value : null
}

/** Cast, directors/creators and keywords for one movie or series. */
async function tmdbCredits(
  kind: 'movie' | 'series',
  imdbId: string,
  priority: TaskPriority
): Promise<TitleCredits | null> {
  const { apiKey } = tmdbCredentials()
  if (!apiKey || !/^tt\d+$/.test(imdbId)) return null

  const tmdbId = await tmdbIdFor(kind, imdbId, apiKey, priority)
  if (!tmdbId) return EMPTY_CREDITS

  const path = kind === 'series' ? 'tv' : 'movie'
  const detail = await fetchJson<RawApiPayload>(
    `https://api.themoviedb.org/3/${path}/${tmdbId}?api_key=${encodeURIComponent(apiKey)}&append_to_response=credits,keywords`,
    {},
    { priority, label: 'TMDB credits' }
  )

  const cast = clean(
    (detail.credits?.cast || []).map((person: RawApiPayload) => person?.name),
    MAX_CAST
  )
  // A film has directors in the crew; a show has created_by instead and
  // usually no crew Director at all. Both, so neither shape comes back
  // empty because it was asked the other one's question.
  const directors = (detail.credits?.crew || [])
    .filter((person: RawApiPayload) => person?.job === 'Director')
    .map((person: RawApiPayload) => person?.name)
  const creators = clean(
    [...directors, ...(detail.created_by || []).map((person: RawApiPayload) => person?.name)],
    MAX_CREATORS
  )
  // TMDB puts a film's keywords under `keywords` and a show's under
  // `results`, inside the same `keywords` object. Not a typo here.
  const rawKeywords = detail.keywords?.keywords || detail.keywords?.results || []
  const keywords = clean(
    rawKeywords.map((keyword: RawApiPayload) => keyword?.name),
    MAX_KEYWORDS
  )

  return { cast, creators, keywords }
}

/**
 * AniList tags and studios for a batch of anime, keyed by Kitsu id.
 *
 * Batched because it can be: one GraphQL document holds twenty aliased
 * Media queries, so enriching the whole anime catalog is about fifty
 * requests rather than fifteen hundred. Same shape, and the same batch
 * size, as anilist.ts's own relations fetch.
 *
 * Only ids this app has already mapped are asked for — the mapping is a
 * free by-product of the franchise-grouping pass, so this never pays for
 * a lookup of its own.
 */
async function anilistCredits(
  kitsuIds: string[],
  priority: TaskPriority
): Promise<Map<string, TitleCredits>> {
  const out = new Map<string, TitleCredits>()
  const pairs: { kitsuId: string; anilistId: number }[] = []
  for (const kitsuId of kitsuIds) {
    const anilistId = cachedAnilistId(kitsuId.replace(/^kitsu:/, ''))
    // No mapping is a real answer: this title has nothing to enrich from,
    // and recording that stops it being retried every pass.
    if (!anilistId) out.set(kitsuId, EMPTY_CREDITS)
    else pairs.push({ kitsuId, anilistId })
  }

  for (let i = 0; i < pairs.length; i += ANILIST_BATCH_SIZE) {
    const batch = pairs.slice(i, i + ANILIST_BATCH_SIZE)
    const query = `query {
      ${batch
        .map(
          ({ anilistId }, index) => `a${index}: Media(id: ${anilistId}, type: ANIME) {
        tags { name rank isGeneralSpoiler }
        studios(isMain: true) { nodes { name } }
      }`
        )
        .join('\n')}
    }`
    try {
      const result = await fetchJson<{ data?: Record<string, RawApiPayload | null> }>(
        'https://graphql.anilist.co',
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ query })
        },
        { priority, label: 'AniList tags' }
      )
      batch.forEach(({ kitsuId }, index) => {
        const node = result.data?.[`a${index}`]
        if (!node) {
          out.set(kitsuId, EMPTY_CREDITS)
          return
        }
        // Ranked by how strongly voters think the tag applies, and
        // spoiler tags dropped — a story-type label that gives away the
        // ending is not one to describe a suggestion with.
        const tags = (node.tags || [])
          .filter((tag: RawApiPayload) => !tag?.isGeneralSpoiler)
          .sort((a: RawApiPayload, b: RawApiPayload) => Number(b?.rank || 0) - Number(a?.rank || 0))
          .map((tag: RawApiPayload) => tag?.name)
        out.set(kitsuId, {
          cast: [],
          creators: clean(
            (node.studios?.nodes || []).map((studio: RawApiPayload) => studio?.name),
            MAX_CREATORS
          ),
          keywords: clean(tags, MAX_KEYWORDS)
        })
      })
    } catch (error) {
      logError('credits:anilist', error)
      // This batch contributes nothing and is left uncached, so the next
      // pass tries it again — unlike a title that genuinely has no data,
      // which is cached as empty above.
    }
  }
  return out
}

/**
 * Credits for one title, from cache or live.
 *
 * Returns undefined rather than throwing for every failure mode there is:
 * no TMDB key, an id no source recognises, a request that fails. Callers
 * treat all of them as "this title has no credits", which is also what a
 * fresh install sees for every title until the background pass has been
 * round.
 */
export async function titleCredits(
  type: MediaKind,
  id: string,
  priority: TaskPriority = 'interactive'
): Promise<TitleCredits | undefined> {
  const cached = cachedCredits(id)
  if (cached) return cached

  try {
    if (type === 'anime') {
      const found = (await anilistCredits([id], priority)).get(id)
      if (!found) return undefined
      storeCredits(id, found)
      return found
    }
    const found = await tmdbCredits(type, id, priority)
    if (!found) return undefined
    storeCredits(id, found)
    return found
  } catch (error) {
    logError('credits:fetch', error)
    return undefined
  }
}

/**
 * Fills in credits for a batch of titles that do not have them yet, and
 * reports how many it managed.
 *
 * Bounded by `limit` on purpose. A full pass over this app's catalog and
 * watch history is roughly four thousand titles; doing it in one run would
 * be a long burst of requests against two APIs for a ranking improvement
 * nobody is waiting on. A slice per run, at maintenance priority, gets
 * there over a few sessions and is invisible while it does.
 *
 * Anime first within the batch, and grouped, because those come back
 * twenty to a request — the cheapest coverage available is taken first.
 */
export async function enrichCredits(
  items: Pick<CatalogItem, 'id' | 'type'>[],
  limit: number,
  priority: TaskPriority = 'maintenance'
): Promise<number> {
  const pending = items.filter((item) => item.id && !cachedCredits(String(item.id))).slice(0, limit)
  if (!pending.length) return 0

  const animeIds = pending.filter((item) => item.type === 'anime').map((item) => String(item.id))
  const rest = pending.filter((item) => item.type !== 'anime')

  let filled = 0
  if (animeIds.length) {
    try {
      for (const [id, credits] of await anilistCredits(animeIds, priority)) {
        storeCredits(id, credits)
        filled += 1
      }
    } catch (error) {
      logError('credits:enrich:anime', error)
    }
  }

  for (const item of rest) {
    try {
      const credits = await tmdbCredits(item.type as 'movie' | 'series', String(item.id), priority)
      if (!credits) continue
      storeCredits(String(item.id), credits)
      filled += 1
    } catch (error) {
      logError('credits:enrich', error)
    }
  }
  return filled
}
