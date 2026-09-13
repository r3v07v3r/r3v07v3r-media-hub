// The one status a title has, and the one place it is decided.
//
// Three surfaces used to answer "have I seen this, or am I going to" on
// their own — the grid tiles, the context menu, the detail page — with
// three not-quite-matching copies of the precedence rule. This is the
// rule: watched beats planned beats nothing, and a show part-way through
// is "watching" for display even though it is not a status anybody sets.
//
// The status a person SETS is TitleStatus (shared/media-hub/types.ts):
// not watched, plan to watch, watched. Cycling through them is the control
// in components/media/TitleStatusButton.tsx; the write is
// AppStateContext's setTitleStatus, which hands the whole thing to main.

import type { MediaItem } from '@renderer/types'
import type { TitleStatus } from '@shared/media-hub/types'

/** What a title shows: the three settable statuses plus "watching". */
export type ShownTitleStatus = TitleStatus | 'watching'

export interface TitleStatusOverrides {
  /** The title's own watched state, where the caller knows better than
   *  the MediaItem — the detail page fetches its own history. */
  watched?: boolean
  planned?: boolean
  /** Episodes watched against aired, for a show. */
  progress?: { watched: number; total: number }
}

/**
 * The status of a title, as it should read on screen.
 *
 * `media.watched` is "started" for a show and "seen" for a film (see
 * adapters.ts); `completed` is "every aired episode" for a show and the
 * same as watched for a film. Both come from the same watch history the
 * badges read, so every surface that calls this agrees with every other.
 */
export function titleStatusOf(
  media: Pick<MediaItem, 'mediaType' | 'watched' | 'completed' | 'inMyList'>,
  over: TitleStatusOverrides = {}
): ShownTitleStatus {
  const episodic = media.mediaType !== 'movie'
  const planned = over.planned ?? media.inMyList
  if (episodic) {
    if (over.progress) {
      if (over.progress.total > 0 && over.progress.watched >= over.progress.total) return 'watched'
      if (over.progress.watched > 0) return 'watching'
    } else {
      if (media.completed) return 'watched'
      if (media.watched) return 'watching'
    }
    return planned ? 'planned' : 'unwatched'
  }
  const watched = over.watched ?? (media.watched || media.completed)
  if (watched) return 'watched'
  return planned ? 'planned' : 'unwatched'
}

/** Where one click goes: not watched -> plan to watch -> watched -> not watched. */
export function nextTitleStatus(current: ShownTitleStatus): TitleStatus {
  switch (current) {
    case 'unwatched':
      return 'planned'
    case 'planned':
    case 'watching':
      return 'watched'
    case 'watched':
      return 'unwatched'
  }
}

/** The word on the control for each state. */
export const TITLE_STATUS_LABEL: Record<ShownTitleStatus, string> = {
  unwatched: 'Not watched',
  planned: 'Planned',
  watching: 'Watching',
  watched: 'Watched'
}

/** The verb for reaching each settable state — menu items and tooltips. */
export const TITLE_STATUS_ACTION: Record<TitleStatus, string> = {
  unwatched: 'Mark not watched',
  planned: 'Plan to watch',
  watched: 'Mark watched'
}

/** One glyph per state, from the app's own icon set. */
export const TITLE_STATUS_ICON: Record<ShownTitleStatus, string> = {
  unwatched: 'eye-off',
  planned: 'clock',
  watching: 'play',
  watched: 'check'
}
