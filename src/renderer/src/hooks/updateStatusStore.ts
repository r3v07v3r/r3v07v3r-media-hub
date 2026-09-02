// ONE UPDATER STATE FOR THE WHOLE APP.
//
// A module-level store rather than per-hook useState, because the updater's
// status arrives as a PUSH EVENT and there is no channel to ask main what it
// last said (see preload's `update`: check/notes/install/setChannel/onStatus,
// and no getter). With per-hook state, a surface that mounts after an event
// starts at null: finish a download on the viewer's settings page, open the
// control centre for the first time, and its Updates section would say it had
// not checked and offer no Restart & install for an update already sitting
// ready.
//
// The IPC subscription is opened on first use and DELIBERATELY NEVER CLOSED.
// It is one listener for the life of the window, and holding it is the whole
// point — the last status has to survive every subscriber unmounting so the
// next one to mount sees it rather than a blank.
//
// Its own module, free of React and of AppStateContext, so the behaviour above
// can actually be tested (tests/updateStatusStore.test.ts) rather than only
// asserted in a comment.

import type { UpdateStatusPayload } from '@shared/media-hub/types'

export interface UpdateStoreState {
  status: UpdateStatusPayload | null
  /** A check somebody started here, before main has pushed anything back.
   *  Shared too, so pressing Check on one surface reads as "Checking…" on the
   *  other rather than only where it was pressed. */
  checking: boolean
  /** The running build's own note. Fetched once per window, not once per
   *  mount — it is baked into the build and cannot change while it runs. */
  notes: string
}

const EMPTY: UpdateStoreState = { status: null, checking: false, notes: '' }

/** Replaced wholesale on every change, never mutated: useSyncExternalStore
 *  compares snapshots by identity and would miss an in-place edit. */
let storeState: UpdateStoreState = EMPTY
const storeListeners = new Set<() => void>()
let statusSubscription: (() => void) | null = null
let notesRequested = false

export function setUpdateStoreState(patch: Partial<UpdateStoreState>): void {
  storeState = { ...storeState, ...patch }
  for (const listener of storeListeners) listener()
}

export function readUpdateStore(): UpdateStoreState {
  return storeState
}

export function subscribeToUpdateStore(listener: () => void): () => void {
  storeListeners.add(listener)
  const api = window.api?.mediaHub
  if (api && !statusSubscription) {
    statusSubscription = api.update.onStatus((status) => setUpdateStoreState({ status }))
  }
  // Guarded on `api` as well as on the flag, so a window with no preload
  // bridge does not burn the one attempt it gets — there is nothing to ask
  // there, and marking it asked would be marking a question nobody put.
  if (api && !notesRequested) {
    notesRequested = true
    void api.update
      .notes()
      .then((result) => setUpdateStoreState({ notes: result.current }))
      // Nothing to say is the normal case (any build made outside the release
      // workflow), so a failure to read says nothing.
      .catch(() => {})
  }
  return () => {
    storeListeners.delete(listener)
    // statusSubscription is not torn down here — see the note at the top.
  }
}

/** Tests only: drop everything this module holds between cases. Nothing in the
 *  app calls it — the store's whole job is to outlive its subscribers. */
export function resetUpdateStoreForTests(): void {
  storeState = EMPTY
  storeListeners.clear()
  statusSubscription = null
  notesRequested = false
}
