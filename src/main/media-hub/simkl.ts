// Ported from r3v07v3r-media-hub's src/simkl.cjs. Pure payload
// builders/normalizers for the Simkl scrobble/history API — no I/O here
// (the fetch calls live in the orchestration layer that wires this in).
// Field names and payload shapes intentionally mirror Simkl's REST API
// exactly (snake_case like `last_watched_at`/`watched_at`), not this
// project's camelCase conventions, since these are literal request/response
// bodies for a third-party API.

import type { CatalogItem, HistoryEntry, MediaKind } from '../../shared/media-hub/types'
import {
  hasExpressibleSimklId,
  idsForCatalogId,
  toSimklAnimeEpisode,
  type AnimeSeasonMembers,
  type SimklMediaIds
} from '../../shared/media-hub/serviceIds'

// The id-expressibility half of this module moved to shared/media-hub/
// serviceIds.ts (the ghost-row migration needs it too, and cannot import
// main-process code). Re-exported here so every existing main-side
// import — and the tests that exercise the predicate — keep reading it
// from the module whose payloads it exists to serve.
export {
  idsForCatalogId,
  hasExpressibleSimklId,
  type SimklMediaIds
} from '../../shared/media-hub/serviceIds'

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

/** Simkl's generic "media reference" shape, embedded in movies/shows/anime/episode payloads. */
interface SimklMediaRef {
  title?: string
  year?: number
  ids: SimklMediaIds
}

interface SimklEpisodeRef {
  number?: number
}

interface SimklSeasonEntry {
  number: number
  episodes: SimklEpisodeRef[]
}

interface SimklShowRef extends SimklMediaRef {
  seasons: SimklSeasonEntry[]
}

/**
 * One anime entry and the episodes of it being reported. Flat, and with no
 * season: a Simkl anime entry is one season, numbered from 1, and Simkl's
 * anime guide asks for exactly this under an anime id. See animeEntries.
 */
interface SimklAnimeRef extends SimklMediaRef {
  episodes: SimklEpisodeRef[]
}

/** Body for POST /sync/history — exactly one of movies/shows/anime is set per call. */
export interface SimklHistoryPayload {
  movies?: SimklMediaRef[]
  shows?: SimklShowRef[]
  anime?: SimklAnimeRef[]
}

/** Body for POST /scrobble/{start,pause,stop}. An anime episode carries no
 *  season, for the reason SimklAnimeRef gives. */
interface SimklScrobblePayload {
  progress: number
  movie?: SimklMediaRef
  show?: SimklMediaRef
  anime?: SimklMediaRef
  episode?: { season?: number; number: number }
}

/**
 * Derives Simkl's `ids` object from our internal catalog id string — see
 * idsForCatalogId in shared/media-hub/serviceIds.ts, which is the actual
 * implementation (and the doc for the id conventions).
 */
function mediaIds(item: SimklPushItem): SimklMediaIds {
  return idsForCatalogId(String(item.id || ''))
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
 * The reference an anime entry goes out under.
 *
 * The title's own id keeps its name and year. A later season's entry is
 * named by its id ALONE: the name and year in hand are the show's, which at
 * Simkl are the first season's, and Simkl falls back to matching by title
 * and year when it cannot place an id — the fallback would file a later
 * season under the first, which is the mistake the id is there to prevent.
 * Null when the entry's id is one Simkl cannot be told at all.
 */
function animeRef(item: SimklPushItem, entryId: string): SimklMediaRef | null {
  if (entryId === String(item.id)) return mediaRef(item)
  const ids = idsForCatalogId(entryId)
  return Object.keys(ids).length ? { ids } : null
}

/**
 * The anime half of every history body: the episodes given, as this app
 * holds them, sorted into the Simkl entries they belong to.
 *
 * A merged franchise is one show here and an entry per season at Simkl, so
 * a change that spans seasons becomes one entry per season it touched —
 * the same split planMalPushes makes for MyAnimeList (mal.ts). Where each
 * episode goes is toSimklAnimeEpisode's answer (serviceIds.ts), and an
 * episode with no place at Simkl (a special, a season the group has no
 * member for, a later season before the catalog is grouped) is left out.
 *
 * NEVER an entry without episodes. Sent to /sync/history/remove, an anime
 * reference that names none removes that entry's whole history.
 */
function animeEntries(
  item: SimklPushItem,
  episodes: readonly { season?: number | null; episode?: number | null }[],
  membersOf: AnimeSeasonMembers | undefined
): SimklAnimeRef[] {
  const byEntry = new Map<string, Set<number>>()
  for (const { season, episode } of episodes) {
    const at = toSimklAnimeEpisode({ id: String(item.id), season, episode }, membersOf)
    if (!at) continue
    const numbers = byEntry.get(at.id) ?? new Set<number>()
    numbers.add(at.episode)
    byEntry.set(at.id, numbers)
  }
  const entries: SimklAnimeRef[] = []
  for (const [entryId, numbers] of byEntry) {
    const ref = animeRef(item, entryId)
    if (!ref) continue
    entries.push({
      ...ref,
      episodes: [...numbers].sort((a, b) => a - b).map((number) => ({ number }))
    })
  }
  return entries
}

function animePayload(
  item: SimklPushItem,
  episodes: readonly { season?: number | null; episode?: number | null }[],
  membersOf: AnimeSeasonMembers | undefined
): SimklHistoryPayload {
  const entries = animeEntries(item, episodes, membersOf)
  return entries.length ? { anime: entries } : {}
}

/**
 * Body for a single "mark as watched" call. Movies push a bare ref; shows
 * nest a single episode under a season (defaulting to season 1 when
 * playback doesn't specify one). Anime names the episode in the Simkl entry
 * it belongs to (see animeEntries), which `membersOf` is needed to find
 * for anything past a first season.
 *
 * EMPTY for a title whose id resolves to no Simkl id at all. Simkl treats
 * an empty `ids` as "match this by title and year", so such a push lands
 * on whatever Simkl thinks that string means — possibly the wrong title,
 * possibly a right one the local row can never be joined back to. Either
 * way the account is changed on a guess and the disagreement cannot be
 * reconciled by id afterwards (see unmatchedCatalogIds). Trakt has said
 * the same thing for longer, via traktIds returning null; this is the
 * matching answer for Simkl, and callers skip an empty payload rather
 * than posting it (hasSimklContent).
 */
export function historyPayload(
  item: SimklPushItem,
  playback: PlaybackPosition = {},
  membersOf?: AnimeSeasonMembers
): SimklHistoryPayload {
  if (!hasExpressibleSimklId(String(item?.id ?? ''))) return {}
  if (item.type === 'anime') return animePayload(item, [playback], membersOf)
  const ref = mediaRef(item)
  if (item.type === 'movie') return { movies: [ref] }
  const entry: SimklShowRef = {
    ...ref,
    seasons: [{ number: numberOr(playback.season, 1), episodes: [episodeBlock(playback)] }]
  }
  return { shows: [entry] }
}

/** One title in a batched history push — the same (item, playback) pair
 *  historyPayload takes for a single one. */
interface SimklHistoryEntry {
  item: SimklPushItem
  playback?: PlaybackPosition
}

/**
 * Batched historyPayload: one request body covering many titles at once,
 * so resolving a whole out-of-sync review list is a single Simkl call
 * rather than one per row. Grouping is exactly historyPayload's (movies
 * carry a bare ref, shows nest their season+episode block, anime its
 * entry's episodes), just accumulated per bucket — nothing about a title's
 * own payload changes by being sent alongside others.
 */
export function batchHistoryPayload(
  entries: SimklHistoryEntry[],
  membersOf?: AnimeSeasonMembers
): SimklHistoryPayload {
  const movies: SimklMediaRef[] = []
  const shows: SimklShowRef[] = []
  const anime: SimklAnimeRef[] = []
  for (const { item, playback } of entries) {
    const single = historyPayload(item, playback, membersOf)
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

/** True when a payload has anything in it worth sending — Simkl's
 *  counterpart to trakt.ts's hasTraktContent, and how callers tell an
 *  id-less title's empty payload from a real one. */
export function hasSimklContent(payload: SimklHistoryPayload): boolean {
  return Boolean(payload.movies?.length || payload.shows?.length || payload.anime?.length)
}

/** Same as historyPayload but for marking a whole batch of episode numbers within one season watched at once. */
export function seasonHistoryPayload(
  item: SimklPushItem,
  season: number | undefined,
  episodeNumbers: number[],
  membersOf?: AnimeSeasonMembers
): SimklHistoryPayload {
  if (!hasExpressibleSimklId(String(item?.id ?? ''))) return {}
  if (item.type === 'anime') {
    return animePayload(
      item,
      episodeNumbers.map((episode) => ({ season, episode })),
      membersOf
    )
  }
  const ref = mediaRef(item)
  const entry: SimklShowRef = {
    ...ref,
    seasons: [
      { number: numberOr(season, 1), episodes: episodeNumbers.map((number) => ({ number })) }
    ]
  }
  return { shows: [entry] }
}

/**
 * Every named episode of a title in one body — the whole-title mark and
 * unmark (see tracking.ts's set-title-status handler). Movies take the
 * movie shape; a film routed through the show shape would be a `shows`
 * entry for something that is not one.
 *
 * ALWAYS names its seasons and episodes, and callers must pass the rows
 * they are actually about to change: a show reference with no seasons
 * sent to /sync/history/remove removes the show's ENTIRE history, which is
 * the one request a bulk unwatch must never make by accident. An anime's
 * seasons go out as one entry each, every one naming its episodes (see
 * animeEntries).
 */
export function titleHistoryPayload(
  item: SimklPushItem,
  seasons: readonly { season: number; episodes: readonly number[] }[],
  membersOf?: AnimeSeasonMembers
): SimklHistoryPayload {
  if (!hasExpressibleSimklId(String(item?.id ?? ''))) return {}
  if (item.type === 'anime') {
    return animePayload(
      item,
      seasons.flatMap(({ season, episodes }) => episodes.map((episode) => ({ season, episode }))),
      membersOf
    )
  }
  const ref = mediaRef(item)
  if (item.type === 'movie') return { movies: [ref] }
  const named = seasons.filter((entry) => entry.episodes.length > 0)
  if (!named.length) return {}
  const entry: SimklShowRef = {
    ...ref,
    seasons: named.map((season) => ({
      number: numberOr(season.season, 1),
      episodes: season.episodes.map((number) => ({ number }))
    }))
  }
  return { shows: [entry] }
}

/** Body for POST /scrobble/* — reports in-progress playback rather than a
 *  completed watch. Null on an id Simkl cannot be told, for the reason
 *  historyPayload gives — and for an anime episode with no place at Simkl
 *  (see animeEntries), since a stop near the end is a watched write there. */
export function scrobblePayload(
  item: SimklPushItem,
  playback: PlaybackPosition = {},
  progress = 0,
  membersOf?: AnimeSeasonMembers
): SimklScrobblePayload | null {
  if (!hasExpressibleSimklId(String(item?.id ?? ''))) return null
  if (item.type === 'anime') {
    const at = toSimklAnimeEpisode(
      { id: String(item.id), season: playback.season, episode: playback.episode ?? 1 },
      membersOf
    )
    const anime = at && animeRef(item, at.id)
    return at && anime ? { progress, anime, episode: { number: at.episode } } : null
  }
  const ref = mediaRef(item)
  if (item.type === 'movie') return { progress, movie: ref }
  return {
    progress,
    show: ref,
    episode: { season: numberOr(playback.season, 1), number: numberOr(playback.episode, 1) }
  }
}

/** Minimal fields this port reads from a `/sync/all-items/movies/completed` response. */
export interface SimklMoviesPayload {
  movies?: Array<{
    movie?: { ids?: { imdb?: string; simkl?: number } }
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
 * episodes that Simkl reports a `watched_at` for are included. Movies also
 * carry Simkl's own number as `simklId`: a local row written under a
 * `simkl:<n>` id (see imdbForSimklKeyedId) is folded into its IMDb twin
 * through exactly this pairing.
 */
export function watchedFromAllItems(
  moviesPayload: SimklMoviesPayload = {},
  showsPayload: SimklShowsPayload = {}
): HistoryEntry[] {
  const entries: HistoryEntry[] = []
  for (const entry of moviesPayload.movies || []) {
    const imdb = entry.movie?.ids?.imdb
    if (!imdb) continue
    const simkl = Number(entry.movie?.ids?.simkl)
    entries.push({
      id: imdb,
      simklId: Number.isFinite(simkl) && simkl > 0 ? simkl : null,
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
