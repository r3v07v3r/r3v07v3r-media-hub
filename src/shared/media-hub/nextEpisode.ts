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
