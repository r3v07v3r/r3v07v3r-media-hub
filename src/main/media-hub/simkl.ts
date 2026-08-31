// Ported from r3v07v3r-media-hub's src/simkl.cjs. Pure payload
// builders/normalizers for the Simkl scrobble/history API — no I/O here
// (the fetch calls live in the orchestration layer that wires this in).
// Field names and payload shapes intentionally mirror Simkl's REST API
// exactly (snake_case like `last_watched_at`/`watched_at`), not this
// project's camelCase conventions, since these are literal request/response
// bodies for a third-party API.

import type { CatalogItem, HistoryEntry, MediaKind } from '../../shared/media-hub/types'

/** Season/episode the player is currently at (or was at, for a scrobble). */
export interface PlaybackPosition {
  season?: number
  episode?: number
}

/**
 * Loose shape of the catalog/library item being pushed to Simkl. Only
 * id/title/year/type are guaranteed to be read; `name` is an extra fallback
 * the original source checks (some upstream normalizers use `name` instead
 * of `title`), so it isn't part of CatalogItem but is kept here for parity.
 */
export type SimklPushItem = Pick<CatalogItem, 'id' | 'type' | 'title' | 'year'> &
  Partial<CatalogItem> & { name?: string }

/** At most one id is ever populated, keyed by which service the catalog id encodes. */
export interface SimklMediaIds {
  imdb?: string
  kitsu?: number
  mal?: number
  anilist?: number
  anidb?: number
}

/** Simkl's generic "media reference" shape, embedded in movies/shows/anime/episode payloads. */
export interface SimklMediaRef {
  title?: string
  year?: number
  ids: SimklMediaIds
}

export interface SimklEpisodeRef {
  number?: number
}

export interface SimklSeasonEntry {
  number: number
  episodes: SimklEpisodeRef[]
}

export interface SimklShowRef extends SimklMediaRef {
  seasons: SimklSeasonEntry[]
}

/** Body for POST /sync/history — exactly one of movies/shows/anime is set per call. */
export interface SimklHistoryPayload {
  movies?: SimklMediaRef[]
  shows?: SimklShowRef[]
  anime?: SimklShowRef[]
}

/** Body for POST /scrobble/{start,pause,stop}. */
export interface SimklScrobblePayload {
  progress: number
  movie?: SimklMediaRef
  show?: SimklMediaRef
  anime?: SimklMediaRef
  episode?: { season: number; number: number }
}

/**
 * Derives Simkl's `ids` object from our internal catalog id string.
 * `tt1234567` (Cinemeta/IMDb) maps straight to `{imdb}`; everything else
 * uses this app's `${provider}:${id}` convention (kitsu/mal/anilist/anidb).
 * Unrecognized ids resolve to `{}` — Simkl treats an empty ids object as
 * "match by title/year" fallback rather than an error.
 */
export function mediaIds(item: SimklPushItem): SimklMediaIds {
  return idsForCatalogId(String(item.id || ''))
}

/** The id-string half of mediaIds, for callers with no item in hand. */
export function idsForCatalogId(id: string): SimklMediaIds {
  if (/^tt\d+$/i.test(id)) return { imdb: id }
  for (const key of ['kitsu', 'mal', 'anilist', 'anidb'] as const) {
    if (id.startsWith(`${key}:`)) {
      const value = Number(id.split(':')[1])
      if (Number.isFinite(value)) return { [key]: value } as SimklMediaIds
    }
  }
  return {}
}

/**
 * Whether a catalog id can be expressed to Simkl as a REAL id — the
 * precondition for a push whose outcome can be verified, and for a diff
 * that can ever see the result. An id that resolves to `{}` goes out as a
 * title/year guess: Simkl either matches it against an entry the diff will
 * never join back to this id, or rejects it in a not_found entry that
 * carries no ids and so can't be attributed to anything (see
 * unmatchedCatalogIds). Either way the local record stays where it was and
 * the disagreement resurfaces on the next check, forever.
 */
export function hasExpressibleSimklId(id: string): boolean {
  return Object.keys(idsForCatalogId(id)).length > 0
}

/** Builds the {title, year, ids} reference shared by all Simkl payload variants. */
export function mediaRef(item: SimklPushItem): SimklMediaRef {
  return {
    title: item.title || item.name,
    year: Number.parseInt(String(item.year), 10) || undefined,
    ids: mediaIds(item)
  }
}

function episodeBlock(playback: PlaybackPosition): SimklEpisodeRef {
  return { number: playback.episode }
}

// `x || 1` would silently turn a real season 0 (Simkl's own specials
// convention) into season 1, misreporting specials-watched to the user's
// real Simkl account under the wrong season — 0 is falsy in JS, not
// "missing". Only a genuinely non-numeric/absent value should fall back.
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Body for a single "mark as watched" call. Movies push a bare ref; shows
 * and anime nest a single episode under a season (defaulting to season 1
 * when playback doesn't specify one, e.g. a movie-shaped anime special).
 */
export function historyPayload(
  item: SimklPushItem,
  playback: PlaybackPosition = {}
): SimklHistoryPayload {
  const ref = mediaRef(item)
  if (item.type === 'movie') return { movies: [ref] }
  const entry: SimklShowRef = {
    ...ref,
    seasons: [{ number: numberOr(playback.season, 1), episodes: [episodeBlock(playback)] }]
  }
  return item.type === 'anime' ? { anime: [entry] } : { shows: [entry] }
}

/** One title in a batched history push — the same (item, playback) pair
 *  historyPayload takes for a single one. */
export interface SimklHistoryEntry {
  item: SimklPushItem
  playback?: PlaybackPosition
}

/**
 * Batched historyPayload: one request body covering many titles at once,
 * so resolving a whole out-of-sync review list is a single Simkl call
 * rather than one per row. Grouping is exactly historyPayload's (movies
 * carry a bare ref, shows/anime nest their season+episode block), just
 * accumulated per bucket — nothing about a title's own payload changes by
 * being sent alongside others.
 */
export function batchHistoryPayload(entries: SimklHistoryEntry[]): SimklHistoryPayload {
  const movies: SimklMediaRef[] = []
  const shows: SimklShowRef[] = []
  const anime: SimklShowRef[] = []
  for (const { item, playback } of entries) {
    const single = historyPayload(item, playback)
    if (single.movies) movies.push(...single.movies)
    if (single.shows) shows.push(...single.shows)
    if (single.anime) anime.push(...single.anime)
  }
  const payload: SimklHistoryPayload = {}
  if (movies.length) payload.movies = movies
  if (shows.length) payload.shows = shows
  if (anime.length) payload.anime = anime
  return payload
}

/**
 * What Simkl answers a /sync/history (or /sync/history/remove) POST with.
 * Only `not_found` is read here, and it is the whole reason this type
 * exists: Simkl replies 200 whether or not it actually matched anything
 * that was sent, listing everything it couldn't resolve under not_found.
 * Treating the 200 alone as success means a push that changed nothing on
 * the account is indistinguishable from one that worked — which is
 * exactly how a "keep local" decision could vanish from the review list
 * and then reappear, unchanged, on the next launch.
 */
export interface SimklHistoryResponse {
  not_found?: {
    movies?: Array<{ ids?: SimklMediaIds }>
    shows?: Array<{ ids?: SimklMediaIds }>
    anime?: Array<{ ids?: SimklMediaIds }>
    episodes?: Array<{ ids?: SimklMediaIds }>
  }
}

/** Flattens an ids object into comparable `service:value` keys (lowercased,
 *  since Simkl echoes IMDb ids back in whatever case they arrived in). */
function idKeys(ids: SimklMediaIds | undefined): string[] {
  return Object.entries(ids || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .map(([service, value]) => `${service}:${String(value).toLowerCase()}`)
}

/**
 * Which of the pushed items Simkl reported it could not match, as this
 * app's own catalog ids. Matching is done through mediaIds — the same
 * mapping the request was built with — so an entry Simkl echoes back
 * under a different id space than the one we sent is still attributed to
 * the right item. not_found entries that carry no ids at all can't be
 * attributed to anything and are ignored rather than guessed at; the
 * items they belong to are treated as pushed, and if they genuinely
 * weren't, the disagreement simply resurfaces on a later check.
 */
export function unmatchedCatalogIds(
  response: SimklHistoryResponse | null | undefined,
  items: SimklPushItem[]
): string[] {
  const notFound = response?.not_found
  if (!notFound) return []
  const unmatched = new Set<string>()
  for (const group of [notFound.movies, notFound.shows, notFound.anime, notFound.episodes]) {
    for (const entry of group || []) for (const key of idKeys(entry?.ids)) unmatched.add(key)
  }
  if (!unmatched.size) return []
  return items
    .filter((item) => idKeys(mediaIds(item)).some((key) => unmatched.has(key)))
    .map((item) => String(item.id))
}

/** Same as historyPayload but for marking a whole batch of episode numbers within one season watched at once. */
export function seasonHistoryPayload(
  item: SimklPushItem,
  season: number | undefined,
  episodeNumbers: number[]
): SimklHistoryPayload {
  const ref = mediaRef(item)
  const entry: SimklShowRef = {
    ...ref,
    seasons: [
      { number: numberOr(season, 1), episodes: episodeNumbers.map((number) => ({ number })) }
    ]
  }
  return item.type === 'anime' ? { anime: [entry] } : { shows: [entry] }
}

/** Body for POST /scrobble/* — reports in-progress playback rather than a completed watch. */
export function scrobblePayload(
  item: SimklPushItem,
  playback: PlaybackPosition = {},
  progress = 0
): SimklScrobblePayload {
  const ref = mediaRef(item)
  if (item.type === 'movie') return { progress, movie: ref }
  const key = item.type === 'anime' ? 'anime' : 'show'
  return {
    progress,
    [key]: ref,
    episode: { season: numberOr(playback.season, 1), number: numberOr(playback.episode, 1) }
  } as SimklScrobblePayload
}

/** Minimal fields this port reads from a `/sync/all-items/movies/completed` response. */
export interface SimklMoviesPayload {
  movies?: Array<{
    movie?: { ids?: { imdb?: string } }
    last_watched_at?: string
  }>
}

/** Minimal fields this port reads from a `/sync/all-items/shows/all` (or anime) response. */
export interface SimklShowsPayload {
  shows?: Array<{
    show?: { ids?: { imdb?: string } }
    seasons?: Array<{
      number?: number
      episodes?: Array<{ number?: number; watched_at?: string }>
    }>
  }>
}

/**
 * Flattens Simkl's "all items" sync responses (one call for movies, one for
 * shows) into this app's flat HistoryEntry list, keyed by IMDb id since
 * that's the only id space this app's history matches against. Entries
 * without an imdb id (Simkl couldn't resolve one) are dropped. Only
 * episodes that Simkl reports a `watched_at` for are included.
 */
export function watchedFromAllItems(
  moviesPayload: SimklMoviesPayload = {},
  showsPayload: SimklShowsPayload = {}
): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const entry of moviesPayload.movies || []) {
    const imdb = entry.movie?.ids?.imdb
    if (!imdb) continue
    entries.push({
      id: imdb,
      type: 'movie' as MediaKind,
      season: null,
      episode: null,
      watchedAt: entry.last_watched_at ?? null
    })
  }
  for (const entry of showsPayload.shows || []) {
    const imdb = entry.show?.ids?.imdb
    if (!imdb) continue
    for (const season of entry.seasons || []) {
      for (const ep of season.episodes || []) {
        if (!ep.watched_at) continue
        entries.push({
          id: imdb,
          type: 'series' as MediaKind,
          season: numberOr(season.number, 1),
          episode: numberOr(ep.number, 0),
          watchedAt: ep.watched_at
        })
      }
    }
  }
  return entries
}
