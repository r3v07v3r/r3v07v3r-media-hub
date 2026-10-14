// The phone and TV app asks for a catch-up again after one fails
// (src/app-ui/lib/librarySync.ts).
//
// It asks when the app opens and when it comes back to the front. A pass
// that rejected, or that answered with an error, used to wait for the next
// of those, and a TV that stays in the foreground may never have one: the
// library stayed as it was for the whole session. Pinned here: a failed
// pass is asked again on the deferred case's few-minute timer, only so many
// times in a row, and a pass that succeeds starts the count over.
//
// Run with: npx tsx tests/catchUpRetry.test.ts

import assert from 'node:assert/strict'

import { requestCatchUp } from '../src/app-ui/lib/librarySync'
import type { CatchUpReport } from '../src/shared/media-hub/types'

const RETRY_MS = 3 * 60 * 1000

const timers = new Map<number, { fn: () => void; ms: number }>()
let nextTimer = 1
let calls = 0
let answer: () => Promise<CatchUpReport> = () => Promise.reject(new Error('unset'))

;(globalThis as { window?: unknown }).window = {
  location: { hash: '#/' },
  setTimeout(fn: () => void, ms: number) {
    const id = nextTimer++
    timers.set(id, { fn, ms })
    return id
  },
  clearTimeout(id: number | undefined) {
    if (id !== undefined) timers.delete(id)
  },
  api: {
    mediaHub: {
      tracking: {
        catchUp() {
          calls += 1
          return answer()
        }
      }
    }
  }
}

function report(patch: Partial<CatchUpReport> = {}): CatchUpReport {
  return {
    at: Date.now(),
    connected: true,
    changed: false,
    plannedAdded: 0,
    plannedRemoved: 0,
    plays: 0,
    followed: 0,
    skipped: 0,
    deferred: false,
    ...patch
  }
}

/** Lets a pass's then/catch/finally run. */
function settle(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

/** The one armed retry, or null; asserts there is never more than one. */
function pendingRetry(): { fn: () => void; ms: number } | null {
  assert.ok(timers.size <= 1, `one retry timer at a time, found ${timers.size}`)
  const [entry] = timers.entries()
  return entry ? entry[1] : null
}

async function fireRetry(): Promise<void> {
  const [entry] = timers.entries()
  assert.ok(entry, 'a retry is armed')
  timers.delete(entry[0])
  entry[1].fn()
  await settle()
}

let pass = 0
async function check(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

async function main(): Promise<void> {
  await check('a pass that rejects is asked again in a few minutes, a few times', async () => {
    calls = 0
    answer = () => Promise.reject(new Error('socket closed'))
    requestCatchUp()
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS)
    while (pendingRetry()) await fireRetry()
    assert.equal(calls, 1 + 5, 'the first ask and five retries, then it waits for a resume')
  })

  await check('a clean pass starts the count over and arms nothing', async () => {
    calls = 0
    answer = () => Promise.resolve(report())
    requestCatchUp()
    await settle()
    assert.equal(calls, 1)
    assert.equal(pendingRetry(), null, 'nothing failed and nothing was put off')
  })

  await check('a pass that reports an error is asked again too', async () => {
    calls = 0
    answer = () => Promise.resolve(report({ error: 'Simkl answered 503' }))
    requestCatchUp()
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS, 'the count was reset by the clean pass')
    answer = () => Promise.resolve(report())
    await fireRetry()
    assert.equal(calls, 2)
    assert.equal(pendingRetry(), null, 'the retry succeeded, so nothing more is armed')
  })

  await check('a pass put off is still asked again, as before', async () => {
    answer = () => Promise.resolve(report({ deferred: true }))
    requestCatchUp()
    await settle()
    assert.equal(pendingRetry()?.ms, RETRY_MS)
    timers.clear()
  })

  console.log(`\n${pass} passed`)
}

void main()
