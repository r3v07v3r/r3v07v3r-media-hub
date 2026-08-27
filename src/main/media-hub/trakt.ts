// Payload builders for Trakt. No I/O — see traktClient.ts for that.
//
// Split the same way Simkl is (simkl.ts / simklClient.ts), and for the same
// reason: the shapes are the part that is easy to get subtly wrong and
// impossible to check against a live account from a test, so they are pure and
// tested while the transport is thin enough to read.
//
// WHAT TRAKT IDENTIFIES TITLES BY. Trakt accepts several id types but this
// app's catalog only ever holds one it recognises: movies and series carry
// IMDb ids. Anime is Kitsu-identified, which Trakt has never heard of, so
// anime is not pushed at all rather than guessed at by title — the same line
// the Servarr request, the watch providers and the content rating already
// draw, and for the same reason: a confident wrong match is worse than a
// missing one.

import type { CatalogItem, MediaKind } from '../../shared/media-hub/types'

/** The minimum a caller has to hand over. Mirrors SimklPushItem next door. */
export type TraktPushItem = Pick<CatalogItem, 'id' | 'type' | 'title'> & Partial<CatalogItem>

export interface TraktIds {
  imdb: string
}

export interface TraktPlaybackPosition {
  season?: number
  episode?: number
}

interface TraktMovieEntry {
  ids: TraktIds
  watched_at?: string
  rating?: number
}

interface TraktEpisodeEntry {
  number: number
}

interface TraktSeasonEntry {
  number: number
  episodes: TraktEpisodeEntry[]
}

interface TraktShowEntry {
  ids: TraktIds
  seasons?: TraktSeasonEntry[]
  rating?: number
}

export interface TraktSyncPayload {
  movies?: TraktMovieEntry[]
  shows?: TraktShowEntry[]
}

export interface TraktScrobblePayload {
  progress: number
  movie?: { ids: TraktIds }
  show?: { ids: TraktIds }
  episode?: { season: number; number: number }
}

/**
 * The IMDb id Trakt can act on, or null.
 *
 * Null is the ordinary answer for anime and for anything whose catalog id is
 * not an IMDb one; every caller below returns an empty payload rather than
 * inventing an identifier.
 */
export function traktIds(item: TraktPushItem): TraktIds | null {
  const id = String(item?.id ?? '')
  return /^tt\d+$/.test(id) ? { imdb: id } : null
}

/** True when this title can be sent to Trakt at all. */
export function isTraktPushable(item: TraktPushItem): boolean {
  return item?.type !== 'anime' && traktIds(item) !== null
}

function numberOr(value: unknown, fallback: number): number {
  const parsed = Number(value)
  // `|| fallback` would turn a real season 0 — the specials convention — into
  // season 1, filing specials under the wrong season on somebody's account.
  return Number.isFinite(parsed) ? parsed : fallback
}

/**
 * Body for POST /sync/history and /sync/history/remove.
 *
 * A movie is one entry. An episode is a SHOW carrying exactly the one season
 * and episode being reported — Trakt reads a show entry with no seasons as
 * "the entire show", so omitting them on an episode-level call would mark a
 * whole series watched from a single episode.
 */
export function historyPayload(
  item: TraktPushItem,
  playback: TraktPlaybackPosition = {},
  watchedAt?: string
): TraktSyncPayload {
  const ids = traktIds(item)
  if (!ids || !isTraktPushable(item)) return {}

  if (item.type === 'movie') {
    return { movies: [{ ids, ...(watchedAt ? { watched_at: watchedAt } : {}) }] }
  }
  return {
    shows: [
      {
        ids,
        seasons: [
          {
            number: numberOr(playback.season, 1),
            episodes: [{ number: numberOr(playback.episode, 1) }]
          }
        ]
      }
    ]
  }
}

/**
 * Same as historyPayload, but for a whole batch of episode numbers within
 * one season at once — the "mark this season watched" action, which is one
 * Trakt request covering every episode rather than one per episode. Mirrors
 * simkl.ts's own seasonHistoryPayload, both in shape and in reasoning: a
 * movie has no seasons to batch, so it is not accepted here at all — the
 * single-item historyPayload already covers it.
 */
export function seasonHistoryPayload(
  item: TraktPushItem,
  season: number | undefined,
  episodeNumbers: number[]
): TraktSyncPayload {
  const ids = traktIds(item)
  if (!ids || !isTraktPushable(item) || item.type !== 'series' || !episodeNumbers.length) return {}
  return {
    shows: [
      {
        ids,
        seasons: [
          { number: numberOr(season, 1), episodes: episodeNumbers.map((number) => ({ number })) }
        ]
      }
    ]
  }
}

/**
 * Body for POST /sync/ratings.
 *
 * Rates the TITLE rather than an episode even for a series: this app's own
 * rating is per title (see shared/media-hub/rating.ts), and inventing an
 * episode-level rating from it would be reporting something nobody said.
 */
export function ratingsPayload(item: TraktPushItem, rating: number): TraktSyncPayload {
  const ids = traktIds(item)
  const score = Math.round(Number(rating))
  if (!ids || !isTraktPushable(item)) return {}
  if (!Number.isFinite(score) || score < 1 || score > 10) return {}
  return item.type === 'movie'
    ? { movies: [{ ids, rating: score }] }
    : { shows: [{ ids, rating: score }] }
}

/**
 * Body for POST /sync/ratings/remove.
 *
 * The SAME shape ratingsPayload sends when adding one — a bare entry keyed
 * only by id, with no season/episode hierarchy — because a rating was
 * recorded at the TITLE level and a removal has to name that same level to
 * match it. historyPayload is the wrong builder to reuse here even though
 * its own shape is otherwise close: for a series it synthesizes a season
 * 1/episode 1 hierarchy when none is given (see its own doc comment),
 * which asks Trakt to remove an EPISODE-level record that this app never
 * wrote, leaving the real show-level rating in place.
 */
export function ratingRemovalPayload(item: TraktPushItem): TraktSyncPayload {
  const ids = traktIds(item)
  if (!ids || !isTraktPushable(item)) return {}
  return item.type === 'movie' ? { movies: [{ ids }] } : { shows: [{ ids }] }
}

/**
 * Body for POST /scrobble/{start,pause,stop}.
 *
 * `progress` is a PERCENTAGE and Trakt treats it as meaningful: a stop above
 * its completion threshold is a watch, below it is a partial. Clamped rather
 * than trusted, because a figure outside 0-100 would be silently interpreted.
 */
export function scrobblePayload(
  item: TraktPushItem,
  playback: TraktPlaybackPosition = {},
  progress = 0
): TraktScrobblePayload | null {
  const ids = traktIds(item)
  if (!ids || !isTraktPushable(item)) return null
  const pct = Math.min(100, Math.max(0, Number(progress) || 0))
  if (item.type === 'movie') return { progress: pct, movie: { ids } }
  return {
    progress: pct,
    show: { ids },
    episode: { season: numberOr(playback.season, 1), number: numberOr(playback.episode, 1) }
  }
}

/** True when a payload has anything in it worth sending. */
export function hasTraktContent(payload: TraktSyncPayload): boolean {
  return Boolean(payload.movies?.length || payload.shows?.length)
}

/** Kinds this app can push. Exported so callers can say why they skipped. */
export const TRAKT_PUSHABLE_KINDS: readonly MediaKind[] = ['movie', 'series']

// ---------------------------------------------------------------------------
// Reading Trakt back.
//
// The other direction, and a different problem. Pushing is about producing
// a shape Trakt accepts; pulling is about deciding which of ITS rows this
// app can honestly claim to recognise.
//
// The answer is the same line drawn everywhere else here: an IMDb id, or
// nothing. Trakt returns rows carrying only a TMDB or TVDB id — its own
// catalog is wider than this one — and there is no id in those rows this
// app's tables are keyed by. Those rows are COUNTED and skipped, never
// matched by title: a confident wrong match writes somebody else's viewing
// into this person's history, where it will quietly steer every
// recommendation from then on.
//
// An episode is filed under its SHOW's IMDb id, not the episode's. That is
// how this app keys watch history — one content id plus season and episode
// columns — and Trakt supplies both halves in the same row.
// ---------------------------------------------------------------------------

import type { ImportedPlay } from '../../shared/media-hub/types'

/** The fields this app reads off a Trakt title. Everything else is ignored. */
interface TraktTitleRow {
  title?: unknown
  year?: unknown
  ids?: { imdb?: unknown }
}

export interface TraktHistoryRow {
  watched_at?: unknown
  type?: unknown
  movie?: TraktTitleRow
  show?: TraktTitleRow
  episode?: { season?: unknown; number?: unknown }
}

export interface TraktRatingRow {
  rating?: unknown
  rated_at?: unknown
  movie?: TraktTitleRow
  show?: TraktTitleRow
}

/** What a parse understood, and what it had to leave behind. */
export interface ParsedImport<T> {
  rows: T[]
  skipped: number
}

function imdbId(row: TraktTitleRow | undefined): string {
  const id = String(row?.ids?.imdb ?? '')
  return /^tt\d+$/.test(id) ? id : ''
}

/** A finite integer, or null. Season 0 is the specials convention and survives. */
function coordinate(value: unknown): number | null {
  const parsed = Number(value)
  // `value ?? null` first, because Number(null) is 0 — which would file every
  // coordinate-less row as season 0 episode 0.
  return value === null || value === undefined || !Number.isFinite(parsed)
    ? null
    : Math.trunc(parsed)
}

/**
 * Trakt's /sync/history rows as viewings this app can store.
 *
 * `watched_at` is carried through untouched. It is the field the whole
 * import exists to preserve — see ImportedPlay — and a row without a usable
 * one is skipped rather than dated today.
 */
export function parseTraktHistory(payload: unknown): ParsedImport<ImportedPlay> {
  const list = Array.isArray(payload) ? (payload as TraktHistoryRow[]) : []
  const rows: ImportedPlay[] = []
  let skipped = 0
  for (const entry of list) {
    const watchedAt = String(entry?.watched_at ?? '').trim()
    // Parseable, not merely present: this string is written straight into a
    // date column that every history view, stat and cadence calculation
    // sorts on.
    if (!watchedAt || Number.isNaN(Date.parse(watchedAt))) {
      skipped += 1
      continue
    }
    const isEpisode = entry?.type === 'episode' || Boolean(entry?.episode)
    const source = isEpisode ? entry?.show : entry?.movie
    const id = imdbId(source)
    if (!id) {
      skipped += 1
      continue
    }
    rows.push({
      id,
      type: isEpisode ? 'series' : 'movie',
      title: String(source?.title ?? '').trim() || 'Untitled',
      year: source?.year ? String(source.year) : '',
      season: isEpisode ? coordinate(entry?.episode?.season) : null,
      episode: isEpisode ? coordinate(entry?.episode?.number) : null,
      watchedAt
    })
  }
  return { rows, skipped }
}

/**
 * Trakt's /sync/ratings/{movies,shows} rows as scores this app can store.
 *
 * Both services use the same 1-10 scale, so nothing is rescaled — a rescale
 * is a place for an off-by-one to change somebody's opinion. Anything
 * outside it is skipped by the writer (see importRatings) rather than
 * clamped.
 */
export function parseTraktRatings(
  payload: unknown
): ParsedImport<{ id: string; score: number; type: 'movie' | 'series'; title: string }> {
  const list = Array.isArray(payload) ? (payload as TraktRatingRow[]) : []
  const rows: { id: string; score: number; type: 'movie' | 'series'; title: string }[] = []
  let skipped = 0
  for (const entry of list) {
    const source = entry?.movie ?? entry?.show
    const id = imdbId(source)
    const score = Math.round(Number(entry?.rating))
    if (!id || !Number.isFinite(score) || score < 1 || score > 10) {
      skipped += 1
      continue
    }
    rows.push({
      id,
      score,
      type: entry?.movie ? 'movie' : 'series',
      title: String(source?.title ?? '').trim() || 'Untitled'
    })
  }
  return { rows, skipped }
}
