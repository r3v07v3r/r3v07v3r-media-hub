// What "set this title's status" has to do, decided without a database,
// a network or Electron in reach — the same split watchlistRules.ts and
// roomRules.ts use, so the decision can be unit tested and the handler in
// tracking.ts is only the hands.
//
// Three statuses, one title: not watched, plan to watch, watched. Plan to
// watch is the tracked table; watched is watch_history — a film's own row,
// or every aired regular episode of a show. Marking a planned title
// watched takes it off the plan (the services do the same by themselves).
// Clearing a watched title clears its history and NOTHING ELSE: a plan it
// also carried stays, so it reads as planned again. The alternative — an
// un-plan sent to the services on the way — is Simkl's unscoped
// history/remove for a bare show, which erases whatever history that
// account holds beyond the episodes just named (docs/WATCHLIST-SYNC.md
// rules 3 and 8); "Remove from plan" is its own, evidence-gated action.
// Planning never touches history: "plan to watch" on something already
// seen is a plan to see it again, and the badge keeps saying watched
// until it is cleared.

import type { Episode, TitleStatus } from '../../shared/media-hub/types'
import { hasAired, isRegularEpisode } from '../../shared/media-hub/catalog-logic'

export interface EpisodeRef {
  season: number
  episode: number
}

/** One season's episode numbers — the shape every whole-title push wants. */
export interface SeasonEpisodes {
  season: number
  episodes: number[]
}

/** `season:episode`, the key watch history is compared by. */
export function episodeKey(season: number | null | undefined, episode: number): string {
  return `${season ?? 1}:${episode}`
}

/**
 * Every episode of a title that has aired and counts — season 0 is shown
 * on the page but never marked by a whole-title action (see
 * isRegularEpisode), and an unaired episode cannot have been seen.
 */
export function airedRegularEpisodes(
  videos: readonly Episode[] | undefined,
  now = Date.now()
): EpisodeRef[] {
  const refs: EpisodeRef[] = []
  const seen = new Set<string>()
  for (const video of videos ?? []) {
    if (!isRegularEpisode(video) || !hasAired(video, now)) continue
    const season = Number(video.season)
    const episode = Number(video.episode)
    if (!Number.isFinite(season) || !Number.isFinite(episode)) continue
    const key = episodeKey(season, episode)
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ season, episode })
  }
  return refs
}

/** Episode refs grouped by season, seasons and episodes ascending. */
export function bySeason(refs: readonly EpisodeRef[]): SeasonEpisodes[] {
  const seasons = new Map<number, Set<number>>()
  for (const ref of refs) {
    let set = seasons.get(ref.season)
    if (!set) {
      set = new Set()
      seasons.set(ref.season, set)
    }
    set.add(ref.episode)
  }
  return [...seasons.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([season, episodes]) => ({ season, episodes: [...episodes].sort((a, b) => a - b) }))
}

/** What is true of the title now, read from the database by the caller. */
export interface TitleState {
  planned: boolean
  /** A film: whether its own row exists. A show: ignored. */
  movieWatched: boolean
  /** A show: the episode keys (see episodeKey) already in history. */
  watchedKeys: ReadonlySet<string>
}

export type TitleStatusStep =
  | { kind: 'track' }
  /** Only ever because the title was marked watched — see the file header. */
  | { kind: 'untrack' }
  | { kind: 'mark-movie' }
  | { kind: 'unmark-movie' }
  | { kind: 'mark-episodes'; episodes: EpisodeRef[] }
  | { kind: 'unmark-title' }

/**
 * The steps that take a title from `state` to `target`, in the order they
 * must run. Empty when nothing needs doing.
 *
 * `aired` is the show's aired regular episodes (see airedRegularEpisodes),
 * and is what "watched" means for a show; a film passes `episodic: false`
 * and it is ignored.
 */
export function planTitleStatusChange(
  target: TitleStatus,
  state: TitleState,
  { episodic, aired }: { episodic: boolean; aired: readonly EpisodeRef[] }
): TitleStatusStep[] {
  const steps: TitleStatusStep[] = []
  const watched = episodic ? state.watchedKeys.size > 0 : state.movieWatched

  if (target === 'planned') {
    // Never clears history — see the file header.
    if (!state.planned) steps.push({ kind: 'track' })
    return steps
  }

  if (target === 'watched') {
    if (episodic) {
      const missing = aired.filter(
        (ref) => !state.watchedKeys.has(episodeKey(ref.season, ref.episode))
      )
      if (missing.length) steps.push({ kind: 'mark-episodes', episodes: missing })
    } else if (!state.movieWatched) {
      steps.push({ kind: 'mark-movie' })
    }
    // After the marks, so the un-plan is queued behind the history push
    // (tracking.ts runs the steps in order on one per-title chain).
    if (state.planned) steps.push({ kind: 'untrack' })
    return steps
  }

  // target === 'unwatched' — history only; the plan stays (file header).
  if (watched) steps.push(episodic ? { kind: 'unmark-title' } : { kind: 'unmark-movie' })
  return steps
}
