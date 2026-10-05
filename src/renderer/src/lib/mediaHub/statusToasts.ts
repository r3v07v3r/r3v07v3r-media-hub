// The toasts a one-click status change raises, and the Undo each carries.
//
// Plan to watch and Not interested are one click from a card's menu or the
// status pill, and both make a card leave lists: a plan takes it out of the
// recommendations, a dislike takes it out of the recommendations and, with
// Hide Disliked on, out of browsing too. Remove from plan is one click too,
// and takes a title off a list somebody built, so it has the same Undo. A mis-click used to
// mean finding the title again (My Stuff > Not for me, for a dislike) before
// anything could reverse it. The Undo here reverses exactly the change the
// toast reports. The callers in AppStateContext make it a no-op once the
// state has already gone back some other way (toggleApplies), so a late
// press cannot flip the title the other way.

import type { AppNotification, MediaItem } from '@renderer/types'
import type { TitleStatus } from '@shared/media-hub/types'

type Toast = Omit<AppNotification, 'id' | 'createdAt'>

/** Whether a plan or dislike toggle asked to land on `to` has anything to
 *  do, given whether the title is in that set now. No `to` is a plain click
 *  and always toggles. An Undo passes the state it restores, so one pressed
 *  after the title already went back (from the card menu, say) is a no-op
 *  rather than a second toggle that puts it back on. */
export function toggleApplies(current: boolean, to?: boolean): boolean {
  return to === undefined || current !== to
}

/** Which toast the plan toggle (the card menu's Plan and Remove from plan,
 *  the library side panel's Remove from plan) raises, from the write's
 *  answer: the plan toast when the title is now tracked, the removal toast
 *  when it is not. None when the write gave no answer, and none when the
 *  toggle was itself a toast's Undo: a second toast would offer back the
 *  change just undone. */
export function toastAfterPlanToggle(
  tracked: boolean | undefined,
  fromUndo: boolean
): 'planned' | 'unplanned' | null {
  if (fromUndo || typeof tracked !== 'boolean') return null
  return tracked ? 'planned' : 'unplanned'
}

/** Whether the status pill's change gets the plan toast. Only a move to
 *  Planned of a title that was not planned, since the Undo takes it off the
 *  plan and that is where it started. Not a replay of episodes either: that
 *  is the whole-show Undo running, which is not offered another. */
export function planToastAfterStatus(
  status: TitleStatus,
  wasPlanned: boolean,
  episodes: readonly unknown[] | undefined
): boolean {
  return status === 'planned' && !wasPlanned && !episodes
}

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

/** After Remove from plan, from the card menu or the library side panel.
 *  The Undo puts the title back on the plan. */
export function unplannedToast(
  media: Pick<MediaItem, 'title'>,
  profileId: string,
  undo: () => void
): Toast {
  return {
    tone: 'info',
    message: `"${media.title}" is off your plan.`,
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
