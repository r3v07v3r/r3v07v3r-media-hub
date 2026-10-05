// The toasts a one-click status change raises, and the Undo each carries.
//
// Plan to watch and Not interested are one click from a card's menu or the
// status pill, and both make a card leave lists: a plan takes it out of the
// recommendations, a dislike takes it out of the recommendations and, with
// Hide Disliked on (the default), out of browsing too. A mis-click used to
// mean finding the title again (My Stuff > Not for me, for a dislike) before
// anything could reverse it. The Undo here reverses exactly the change the
// toast reports. The callers in AppStateContext make it a no-op once the
// state has already gone back some other way, so a late press cannot flip
// the title the other way.

import type { AppNotification, MediaItem } from '@renderer/types'

type Toast = Omit<AppNotification, 'id' | 'createdAt'>

/** How long these stay on screen. They answer a click just made, so unlike
 *  the whole-show Undo they do not wait to be dismissed. */
export const QUICK_UNDO_MS = 8000

/** After a title goes onto the plan from the card menu or the status pill. */
export function plannedToast(
  media: Pick<MediaItem, 'title'>,
  profileId: string,
  undo: () => void
): Toast {
  return {
    tone: 'success',
    message: `"${media.title}" is on your plan.`,
    profileId,
    durationMs: QUICK_UNDO_MS,
    action: { label: 'Undo', run: undo }
  }
}

/** After Not interested, or after Remove dislike (`disliked` false). Only
 *  the dislike offers an Undo; taking one back is already the way back. */
export function dislikedToast(
  media: Pick<MediaItem, 'title'>,
  disliked: boolean,
  profileId: string,
  undo: () => void
): Toast {
  if (!disliked) {
    return { tone: 'info', message: `You'll see "${media.title}" again.`, profileId }
  }
  return {
    tone: 'info',
    message: `"${media.title}" won't be recommended, and is hidden from browsing while Hide Disliked is on.`,
    profileId,
    durationMs: QUICK_UNDO_MS,
    action: { label: 'Undo', run: undo }
  }
}
