// Which episode follows the one that just finished.
//
// Deliberately "the next episode IN ORDER", not "the next unwatched one".
// Those two answers diverge the moment somebody rewatches: finish S1E04 for
// the second time and the first unwatched episode might be S03E07, and
// dropping the viewer there is exactly the kind of thing that makes autoplay
// feel broken rather than helpful. Every player this one gets compared to —
// Netflix, Plex, Jellyfin, Stremio — advances in order, so this does too.
//
// MediaDetailPage's own `nextEpisode` answers the OTHER question — "where
// should I pick this show up" — and stays first-unwatched on purpose. Two
// different questions, two different rules; they are not a duplication to
// be merged.

import { hasAired } from './catalog-logic'
import type { Episode } from './types'

/** The minimum a caller needs to start the next episode and name it. */
export interface NextEpisodeRef {
  season: number
  episode: number
  title: string
}

/**
 * The episode immediately after `current` in (season, episode) order, or
 * null when there is none.
 *
 * `current` not appearing in `videos` at all is a normal case rather than an
 * error — a season list can be refetched between the play starting and the
 * episode ending, and anime ids are scoped to a single cour so a play target
 * can legitimately sit outside the list it was resolved from. "First entry
 * strictly after this coordinate" gives the right answer either way, which is
 * why the current episode is never looked up directly.
 */
export function nextEpisodeInOrder(
  videos: readonly Episode[] | undefined | null,
  current: { season?: number | null; episode?: number | null }
): NextEpisodeRef | null {
  if (!videos?.length) return null
  // null is rejected BEFORE Number(), not by the finite check after it, because
  // `Number(null)` is 0 rather than NaN. A movie arrives here with both
  // coordinates null, and coercing those to (0, 0) would make the first episode
  // of season 1 "the next one" — an autoplay card on the end of every film.
  if (current.season == null || current.episode == null) return null
  const season = Number(current.season)
  const episode = Number(current.episode)
  if (!Number.isFinite(season) || !Number.isFinite(episode)) return null

  let best: Episode | null = null
  for (const video of videos) {
    // Synthetic "Specials" entries carry no real (season, episode) the
    // scraper/TorBox pipeline can resolve a stream for — see
    // disambiguateVideos in main/media-hub/core.ts. They must never become an
    // autoplay target, and they must not block the real episode behind them
    // either, so they are skipped rather than stopping the walk.
    if (video.unplayable) continue
    if (!Number.isFinite(video.season) || !Number.isFinite(video.episode)) continue
    // Not after the current coordinate — not a candidate.
    if (video.season < season) continue
    if (video.season === season && video.episode <= episode) continue
    // Further away than the best candidate so far — not an improvement.
    if (best) {
      if (video.season > best.season) continue
      if (video.season === best.season && video.episode >= best.episode) continue
    }
    best = video
  }

  if (!best) return null
  return { season: best.season, episode: best.episode, title: String(best.title || '') }
}

/** The key an episode is remembered under in a watched-history set. Exported
 *  so the callers that build the set and the ones that query it cannot drift
 *  into two different spellings of the same coordinate. */
export function episodeWatchKey(
  season: number | null | undefined,
  episode: number | null | undefined
): string {
  return `${season ?? ''}:${episode ?? ''}`
}

/** Episodes somebody could actually start, in (season, episode) order.
 *
 *  Three exclusions, each for its own reason:
 *
 *   - `unplayable`, for the reason given on the field itself:
 *     disambiguateVideos' synthetic Specials have no coordinate the
 *     scraper/TorBox pipeline can resolve a stream for.
 *   - A non-finite coordinate, which cannot be turned into a stream id.
 *   - ANYTHING THAT HAS NOT AIRED. Cinemeta and TMDB both ship future-dated
 *     entries in `videos`, so for a show still airing, "the first unwatched
 *     one" and "the first one you could watch" are different episodes. Caught
 *     up on a currently-airing show, the first of those is next week's — no
 *     source exists for it, so Play would search, find nothing and give up.
 *     hasAired is the same rule airedEpisodes counts progress by, so the
 *     episode Play starts and the episode the progress bar counts cannot come
 *     from two different ideas of "aired".
 *
 *  The sort is defensive: most callers hand this an already-sorted list, but
 *  "first in order" must not depend on that being true.
 *
 *  `now` is injectable for the same reason airedEpisodes' is — a test that
 *  cannot pin the clock cannot test the boundary. */
export function playableEpisodesInOrder(
  videos: readonly Episode[] | undefined | null,
  now: number = Date.now()
): Episode[] {
  return (videos ?? [])
    .filter(
      (video) =>
        !video?.unplayable &&
        Number.isFinite(video?.season) &&
        Number.isFinite(video?.episode) &&
        hasAired(video, now)
    )
    .slice()
    .sort((a, b) => a.season - b.season || a.episode - b.episode)
}

/**
 * Where somebody should pick a show up: the first episode they have not
 * watched, or null when they have watched them all.
 *
 * This is the OTHER question from nextEpisodeInOrder at the top of this file
 * — that one answers "what follows the episode that just ended" and stays
 * strictly in-order so a rewatch does not fling the viewer across the show.
 * This one answers "press Play on this series; what starts", and
 * first-unwatched is the right answer to that one. It lives beside its
 * sibling so the difference between the two is stated once, in one file,
 * rather than rediscovered every time a new surface grows a Play button.
 *
 * MediaDetailPage computes the same answer inline over the Episode objects
 * it already has in hand (it needs the whole episode, not a reference, to
 * drive its grid) — the rule is the same one, deliberately.
 *
 * Null for "all watched" rather than silently restarting: the detail page
 * shows a distinct "you've seen everything" state for it, and a caller that
 * would rather start over says so itself with playableEpisodesInOrder()[0].
 */
export function nextUnwatchedEpisode(
  videos: readonly Episode[] | undefined | null,
  watchedKeys: ReadonlySet<string>,
  now: number = Date.now()
): NextEpisodeRef | null {
  const next = playableEpisodesInOrder(videos, now).find(
    (video) => !watchedKeys.has(episodeWatchKey(video.season, video.episode))
  )
  return next
    ? { season: next.season, episode: next.episode, title: String(next.title || '') }
    : null
}

/**
 * The episode a bare "play this series" should start — first unwatched,
 * falling back to the first episode there is when every one has been seen
 * (pressing Play on a finished show starts it again rather than doing
 * nothing), and to S1E1 when the show has no usable episode list at all.
 *
 * "Every one has been seen" means every one that has AIRED — somebody caught
 * up on a show still in its season is offered the beginning again rather than
 * next week's episode, which has no source to find.
 *
 * S1E1 is the same coordinate buildMediaId already defaults to, so a title
 * whose metadata never arrived behaves exactly as it did before this
 * existed rather than failing in a new way.
 */
export function episodeToStart(
  videos: readonly Episode[] | undefined | null,
  watchedKeys: ReadonlySet<string>,
  now: number = Date.now()
): { season: number; episode: number } {
  const ordered = playableEpisodesInOrder(videos, now)
  const next =
    ordered.find((video) => !watchedKeys.has(episodeWatchKey(video.season, video.episode))) ??
    ordered[0]
  return next ? { season: next.season, episode: next.episode } : { season: 1, episode: 1 }
}
