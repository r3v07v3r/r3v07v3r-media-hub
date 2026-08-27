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
