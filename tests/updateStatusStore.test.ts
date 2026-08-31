// The updater status has to outlive the surface that heard about it.
//
// Two surfaces show it now — the viewer's settings page and the control
// centre's Updates section — and it only ever arrives as a push event, with no
// channel to ask main what it last said. Per-hook state meant whichever one
// mounted second started blank: an update downloaded while you were on the
// settings page, and the control centre opened afterwards would claim it had
// not checked and offer no Restart & install for an update sitting ready.

import assert from 'node:assert/strict'

import {
  readUpdateStore,
  resetUpdateStoreForTests,
  setUpdateStoreState,
  subscribeToUpdateStore
} from '../src/renderer/src/hooks/updateStatusStore'
import type { UpdateStatusPayload } from '../src/shared/media-hub/types'

interface Bridge {
  pushes: ((status: UpdateStatusPayload) => void)[]
  subscribeCalls: number
  notesCalls: number
}

function installBridge(notes = 'note for this build'): Bridge {
  const bridge: Bridge = { pushes: [], subscribeCalls: 0, notesCalls: 0 }
  ;(globalThis as { window?: unknown }).window = {
    api: {
      mediaHub: {
        update: {
          onStatus(handler: (status: UpdateStatusPayload) => void) {
            bridge.subscribeCalls += 1
            bridge.pushes.push(handler)
            return () => {}
          },
          notes() {
            bridge.notesCalls += 1
            return Promise.resolve({ current: notes })
          }
        }
      }
    }
  }
  return bridge
}

function removeBridge(): void {
  ;(globalThis as { window?: unknown }).window = {}
}

// --- THE REPORTED CASE: a late mount sees the last status. ---------------
resetUpdateStoreForTests()
{
  const bridge = installBridge()
  const unsubscribeFirst = subscribeToUpdateStore(() => {})
  bridge.pushes[0]({ state: 'ready', version: '1.0.84' })
  assert.deepEqual(readUpdateStore().status, { state: 'ready', version: '1.0.84' })

  // The surface that heard it goes away — navigate off the settings page.
  unsubscribeFirst()

  // A different surface mounts for the first time afterwards. Before this
  // store it started at null and offered no Restart & install.
  let notified = 0
  subscribeToUpdateStore(() => {
    notified += 1
  })
  assert.deepEqual(readUpdateStore().status, { state: 'ready', version: '1.0.84' })

  // And it keeps hearing new events.
  bridge.pushes[0]({ state: 'current' })
  assert.equal(notified, 1)
  assert.deepEqual(readUpdateStore().status, { state: 'current' })
  console.log('ok  a surface mounting after the event still sees it')
}

// --- One IPC subscription, one notes read, however many surfaces. --------
resetUpdateStoreForTests()
{
  const bridge = installBridge()
  const a = subscribeToUpdateStore(() => {})
  const b = subscribeToUpdateStore(() => {})
  a()
  b()
  subscribeToUpdateStore(() => {})
  assert.equal(bridge.subscribeCalls, 1, 'the IPC listener is opened once and never re-opened')
  assert.equal(bridge.notesCalls, 1, 'the running build note is read once per window')
  console.log('ok  one subscription and one notes read across every surface')
}

// --- Every subscriber is told, and a snapshot is a new object. -----------
resetUpdateStoreForTests()
{
  installBridge()
  let a = 0
  let b = 0
  subscribeToUpdateStore(() => {
    a += 1
  })
  subscribeToUpdateStore(() => {
    b += 1
  })
  const before = readUpdateStore()
  setUpdateStoreState({ checking: true })
  assert.equal(a, 1)
  assert.equal(b, 1)
  // useSyncExternalStore compares snapshots by identity: an in-place edit
  // would render nothing.
  assert.notEqual(readUpdateStore(), before)
  assert.equal(readUpdateStore().checking, true)
  // Unrelated fields survive a partial write.
  assert.equal(readUpdateStore().notes, before.notes)
  console.log('ok  every subscriber is notified with a fresh snapshot')
}

// --- No bridge: no throw, and the one notes attempt is not burnt. --------
resetUpdateStoreForTests()
{
  removeBridge()
  const unsubscribe = subscribeToUpdateStore(() => {})
  assert.equal(readUpdateStore().status, null)
  unsubscribe()

  // The bridge appearing later must still get its subscription — marking the
  // question asked when there was nobody to ask would have lost it.
  const bridge = installBridge()
  subscribeToUpdateStore(() => {})
  assert.equal(bridge.subscribeCalls, 1)
  assert.equal(bridge.notesCalls, 1)
  console.log('ok  a window with no preload bridge degrades quietly')
}

removeBridge()
