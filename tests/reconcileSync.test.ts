// Unit tests for the "keep local" push path of the out-of-sync review:
// the persisted decision queue (src/shared/media-hub/reconcileQueue.ts)
// and the two Simkl helpers it pushes through
// (src/main/media-hub/simkl.ts's batchHistoryPayload/unmatchedCatalogIds),
// and which decisions a flush passes on to Trakt: every one Simkl confirmed
// or that had already settled, which is how "Use Simkl" reaches Trakt.
// Run with: npx tsx tests/reconcileSync.test.ts   (or npm.cmd test)
//
// Both modules are imported directly because both are deliberately
// electron-free; the orchestration around them (tracking.ts) pulls in
// `electron` at module load and would need a full app harness.

import assert from 'node:assert'
import type { PendingWatchStatusPush } from '../src/shared/media-hub/types'
import {
  applyPushOutcome,
  markPushed,
  queuePendingPush,
  reviewRemovalsOwed,
  splitForFlush,
  traktFollowUps,
  verifyPushed,
  withPushedRemoteState
} from '../src/shared/media-hub/reconcileQueue'
import {
  batchHistoryPayload,
  completedListPayload,
  hasExpressibleSimklId,
  hasSimklContent,
  historyPayload,
  idsForCatalogId,
  scrobblePayload,
  seasonHistoryPayload,
  unmatchedCatalogIds
} from '../src/main/media-hub/simkl'

let pass = 0
function check(name: string, fn: () => void): void {
  try {
    fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

function entry(overrides: Partial<PendingWatchStatusPush> = {}): PendingWatchStatusPush {
  return {
    id: 'tt4877122',
    type: 'movie',
    title: 'Split',
    year: '2016',
    remoteWatched: false,
    attempts: 0,
    ...overrides
  }
}

// --- the decision queue ----------------------------------------------------

check('queues a decision', () => {
  const queue = queuePendingPush([], entry())
  assert.equal(queue.length, 1)
  assert.equal(queue[0].id, 'tt4877122')
  assert.equal(queue[0].remoteWatched, false)
})

check('re-deciding the same title replaces it and re-arms its attempts', () => {
  // A push that never landed lets the title resurface for a second
  // ruling — that must not leave two entries fighting over one id, nor
  // inherit the attempt budget the earlier ruling had already burned.
  const stale = entry({ attempts: 3, remoteWatched: true })
  const queue = queuePendingPush([stale], entry({ remoteWatched: false }))
  assert.equal(queue.length, 1)
  assert.equal(queue[0].attempts, 0)
  assert.equal(queue[0].remoteWatched, false)
})

check('records what the remote said, not what the local side said', () => {
  // The local value is deliberately NOT snapshotted: it can change
  // between the click and a delayed or retried push, and the flush is
  // what re-reads it (see tracking.ts's pushPendingToServices). A queue
  // entry that carried a stale `watched: true` would push the exact
  // opposite of local truth once someone unmarked the title.
  const queued = queuePendingPush([], entry({ remoteWatched: false }))[0]
  assert.equal('watched' in queued, false)
  assert.equal(queued.remoteWatched, false)
})

check('a confirmed push leaves the queue', () => {
  const { queue, abandoned } = applyPushOutcome([entry()], ['tt4877122'], [])
  assert.deepEqual(queue, [])
  assert.deepEqual(abandoned, [])
})

check('a failed push stays queued with its attempts bumped', () => {
  const { queue, abandoned } = applyPushOutcome([entry()], [], ['tt4877122'])
  assert.equal(queue.length, 1)
  assert.equal(queue[0].attempts, 1)
  assert.deepEqual(abandoned, [])
})

check('a push that keeps failing is abandoned rather than retried forever', () => {
  const { queue, abandoned } = applyPushOutcome([entry({ attempts: 4 })], [], ['tt4877122'], 5)
  assert.deepEqual(queue, [])
  assert.equal(abandoned.length, 1)
  assert.equal(abandoned[0].attempts, 5)
})

check('entries queued during a flush keep their untouched state', () => {
  // Whatever the in-flight batch decided says nothing about a decision
  // made after that batch was snapshotted.
  const arrivedLate = entry({ id: 'tt0770828', title: 'Man of Steel' })
  const { queue } = applyPushOutcome([entry(), arrivedLate], ['tt4877122'], [])
  assert.deepEqual(queue, [arrivedLate])
})

check('an entry that was pushed but stayed queued learns the new remote state', () => {
  // The push landed, then the local side moved underneath it before the
  // response came back, so the entry is kept rather than confirmed. If
  // it still claimed the remote was unwatched, the next flush would see
  // local unwatched too, call that agreement, and drop the decision —
  // leaving the title watched on Simkl with nothing left to undo it.
  const kept = withPushedRemoteState(
    [entry({ remoteWatched: false })],
    new Map([['tt4877122', true]])
  )
  assert.equal(kept[0].remoteWatched, true)
})

check('leaves entries nothing was pushed for exactly as they are', () => {
  const untouched = [entry({ remoteWatched: false })]
  assert.deepEqual(withPushedRemoteState(untouched, new Map()), untouched)
  // Same object identity when the push agreed with what was recorded —
  // nothing new was learned.
  const agreed = withPushedRemoteState(untouched, new Map([['tt4877122', false]]))
  assert.equal(agreed[0], untouched[0])
})

// --- batched payloads ------------------------------------------------------

// --- what a flush sends, and who else hears of it --------------------------
//
// Trakt is told the value a decision settled on, whether Simkl needed a
// request for it or not. "Use Simkl" rewrites the local record and queues
// the decision; the flush then finds local and Simkl agreeing and passes the
// value to Trakt without asking Simkl anything.

check('an entry local disagrees with is sent; one it agrees with has settled', () => {
  const { sendable, settled } = splitForFlush(
    [entry({ id: 'tt1', remoteWatched: false }), entry({ id: 'tt2', remoteWatched: true })],
    new Set(['tt1', 'tt2']),
    new Set()
  )
  assert.deepEqual(
    sendable.map((e) => e.id),
    ['tt1']
  )
  assert.deepEqual([...settled], ['tt2'])
})

check('agreement against a record known to be stale is not settled', () => {
  const { sendable, settled } = splitForFlush(
    [entry({ id: 'tt2', remoteWatched: true })],
    new Set(['tt2']),
    new Set(['tt2'])
  )
  assert.equal(sendable.length, 1)
  assert.equal(settled.size, 0)
})

check('a "Use Simkl" decision settles and still reaches Trakt', () => {
  // Simkl says watched, local said not; the person picked Simkl, so the
  // local row now exists and the decision is queued with Simkl's value.
  const queue = queuePendingPush([], entry({ id: 'tt9', remoteWatched: true }))
  const { sendable, settled } = splitForFlush(queue, new Set(['tt9']), new Set())
  assert.equal(sendable.length, 0)
  assert.deepEqual(
    traktFollowUps(queue, new Set(), settled).map((e) => e.id),
    ['tt9']
  )
  // And it leaves the queue: settled is done with.
  assert.equal(applyPushOutcome(queue, [...settled], []).queue.length, 0)
})

check('Trakt hears of confirmed and settled entries, never of failed ones', () => {
  const queue = [entry({ id: 'tt1' }), entry({ id: 'tt2' }), entry({ id: 'tt3' })]
  assert.deepEqual(
    traktFollowUps(queue, new Set(['tt1']), new Set(['tt3'])).map((e) => e.id),
    ['tt1', 'tt3']
  )
})

check('a queued "Use Local" removal is held back from the catch-up', () => {
  // Unwatched here, watched at Simkl, and the person picked local: until
  // Simkl takes the removal, the catch-up must not import the film, or the
  // next flush finds both sides agreeing and tells Trakt "watched".
  const queue = [
    entry({ id: 'tt1', remoteWatched: true }),
    entry({ id: 'tt2', remoteWatched: false }),
    entry({ id: 'tt3', type: 'series', remoteWatched: true })
  ]
  assert.deepEqual([...reviewRemovalsOwed(queue, [])], ['tt1:movie:movie'])
  // A title the flush gave up on keeps only its id, and is held as well.
  assert.deepEqual([...reviewRemovalsOwed([], ['tt4'])], ['tt4:movie:movie'])
})

check('batches many movies into one request body', () => {
  const payload = batchHistoryPayload([
    { item: { id: 'tt4877122', type: 'movie', title: 'Split', year: '2016' } },
    { item: { id: 'tt2975590', type: 'movie', title: 'Batman v Superman', year: '2016' } }
  ])
  assert.equal(payload.movies?.length, 2)
  assert.equal(payload.movies?.[0].ids.imdb, 'tt4877122')
  assert.equal(payload.movies?.[1].year, 2016)
  assert.equal(payload.shows, undefined)
  assert.equal(payload.anime, undefined)
})

check('keeps each kind in its own bucket, with episode blocks intact', () => {
  const payload = batchHistoryPayload([
    { item: { id: 'tt4877122', type: 'movie', title: 'Split', year: '2016' } },
    { item: { id: 'tt0903747', type: 'series', title: 'Breaking Bad', year: '2008' } },
    {
      item: { id: 'kitsu:1', type: 'anime', title: 'Cowboy Bebop', year: '1998' },
      playback: { season: 1, episode: 3 }
    }
  ])
  assert.equal(payload.movies?.length, 1)
  assert.equal(payload.shows?.length, 1)
  assert.equal(payload.anime?.length, 1)
  // An anime entry's episodes are flat — see tests/simklAnime.test.ts.
  assert.deepEqual(payload.anime?.[0].episodes, [{ number: 3 }])
  assert.equal(payload.anime?.[0].ids.kitsu, 1)
})

check('an empty batch produces an empty body, not empty arrays', () => {
  assert.deepEqual(batchHistoryPayload([]), {})
})

// --- accepted-but-unmatched detection --------------------------------------

const pushed = [
  { id: 'tt4877122', type: 'movie' as const, title: 'Split', year: '2016' },
  { id: 'tt2975590', type: 'movie' as const, title: 'Batman v Superman', year: '2016' }
]

check('reports nothing unmatched for a clean response', () => {
  assert.deepEqual(unmatchedCatalogIds({}, pushed), [])
  assert.deepEqual(unmatchedCatalogIds({ not_found: { movies: [] } }, pushed), [])
  assert.deepEqual(unmatchedCatalogIds(null, pushed), [])
})

check('attributes a not_found entry back to the catalog id that was pushed', () => {
  // This is the whole point: Simkl answers 200 here, so without reading
  // not_found the caller would call this push a success, drop the
  // decision, and let the same title come back on the next launch.
  const unmatched = unmatchedCatalogIds(
    { not_found: { movies: [{ ids: { imdb: 'tt2975590' } }] } },
    pushed
  )
  assert.deepEqual(unmatched, ['tt2975590'])
})

check('matches ids case-insensitively', () => {
  const unmatched = unmatchedCatalogIds(
    { not_found: { movies: [{ ids: { imdb: 'TT4877122' } }] } },
    pushed
  )
  assert.deepEqual(unmatched, ['tt4877122'])
})

check('ignores not_found entries that carry no ids to attribute', () => {
  // Nothing can be pinned on a specific title here, and guessing would
  // mean retrying pushes that did land. If one genuinely didn't, the
  // disagreement resurfaces on a later check instead.
  assert.deepEqual(unmatchedCatalogIds({ not_found: { movies: [{}] } }, pushed), [])
})

check('attributes anime by its non-IMDb id space too', () => {
  const unmatched = unmatchedCatalogIds({ not_found: { anime: [{ ids: { kitsu: 7 } }] } }, [
    { id: 'kitsu:7', type: 'anime', title: 'Trigun', year: '1998' }
  ])
  assert.deepEqual(unmatched, ['kitsu:7'])
})

// --- which ids the review is allowed to offer at all -----------------------

check('every real id space is expressible to Simkl', () => {
  for (const id of ['tt4877122', 'TT0470752', 'kitsu:7', 'mal:6', 'anilist:30', 'anidb:17']) {
    assert.equal(hasExpressibleSimklId(id), true, `${id} should be expressible`)
  }
})

check('unmappable ids are not, so the review never offers them', () => {
  // A local history row carrying one of these can never be joined to any
  // Simkl entry, and its "Use Local" push would go out as an unverifiable
  // title/year guess — the review row returned after every resolution,
  // forever, until these were excluded. Note what this no longer decides:
  // such a row is still kept locally, and still shown. Only the push is
  // withheld — see serviceIds.ts on the library-write guard that used to
  // read the same predicate and is gone.
  for (const id of ['m-13', 'tmdb:157336', 'simkl:', '', 'not-an-id']) {
    assert.equal(hasExpressibleSimklId(id), false, `${id} should not be expressible`)
  }
})

check('idsForCatalogId matches what a push would actually send', () => {
  assert.deepEqual(idsForCatalogId('tt4877122'), { imdb: 'tt4877122' })
  assert.deepEqual(idsForCatalogId('kitsu:7'), { kitsu: 7 })
  // Simkl's own number is a real id Simkl matches exactly — a row a list
  // card wrote under it is pushable (see simklKeyedHistory.ts).
  assert.deepEqual(idsForCatalogId('simkl:250822'), { simkl: 250822 })
  assert.deepEqual(idsForCatalogId('m-13'), {})
})

// --- what may be SENT to Simkl at all ---------------------------------------

check('a title Simkl has no id for produces no push body', () => {
  // The local write for such a title goes ahead — it is a real title, and
  // this app's own database is the record. What must not happen is a push
  // that carries `ids: {}` and a title/year, which asks Simkl to guess:
  // it can land on the wrong entry, and even a right one produces a row
  // no later diff can join back to this id.
  const unmappable = { id: 'tmdb:157336', type: 'series' as const, title: 'Silo', year: '2023' }
  assert.equal(hasSimklContent(historyPayload(unmappable, { season: 3, episode: 10 })), false)
  assert.equal(hasSimklContent(seasonHistoryPayload(unmappable, 3, [1, 2, 3])), false)
  assert.equal(scrobblePayload(unmappable, { season: 3, episode: 10 }, 40), null)
})

check('a real id still produces one, unchanged', () => {
  const real = { id: 'tt14688458', type: 'series' as const, title: 'Silo', year: '2023' }
  const payload = historyPayload(real, { season: 3, episode: 10 })
  assert.equal(hasSimklContent(payload), true)
  assert.deepEqual(payload.shows?.[0].ids, { imdb: 'tt14688458' })
  assert.equal(payload.shows?.[0].seasons[0].number, 3)
  assert.notEqual(scrobblePayload(real, { season: 3, episode: 10 }, 40), null)
})

check('a batch drops the unaddressable rows and keeps the rest', () => {
  const payload = batchHistoryPayload([
    { item: { id: 'tt14688458', type: 'series', title: 'Silo', year: '2023' } },
    { item: { id: 'tmdb:157336', type: 'series', title: 'Silo', year: '2023' } },
    { item: { id: 'm-13', type: 'movie', title: 'Ex Machina', year: '2014' } }
  ])
  assert.equal(payload.shows?.length, 1)
  assert.equal(payload.movies, undefined)
  assert.equal(hasSimklContent(payload), true)
})

check('a batch of nothing addressable is not worth sending', () => {
  assert.equal(
    hasSimklContent(
      batchHistoryPayload([{ item: { id: 'm-13', type: 'movie', title: 'Ex Machina' } }])
    ),
    false
  )
})

// --- an accepted push is not a landed one ---------------------------------
//
// Seen live: six films pushed and answered 200 with an empty not_found on
// every launch for five weeks, never once watched at Simkl. The queue now
// keeps an accepted push until a read of the account shows it.

check('markPushed flags the accepted entries and records what was sent', () => {
  const queue = [entry({ id: 'a' }), entry({ id: 'b', remoteWatched: true })]
  const marked = markPushed(queue, new Map([['a', true]]))
  assert.deepEqual(marked[0], { ...queue[0], remoteWatched: true, pushed: true })
  assert.deepEqual(marked[1], queue[1])
})

check('a flush leaves an accepted push alone: neither sent nor settled', () => {
  const waiting = entry({ id: 'a', remoteWatched: true, pushed: true })
  const { sendable, settled } = splitForFlush([waiting], new Set(['a']), new Set())
  assert.deepEqual(sendable, [])
  assert.equal(settled.size, 0)
})

check('a read that shows the push lets the entry go', () => {
  const waiting = entry({ id: 'a', remoteWatched: true, pushed: true })
  const other = entry({ id: 'b' })
  const outcome = verifyPushed([waiting, other], (id) => id === 'a')
  assert.deepEqual(outcome.verified, [waiting])
  assert.deepEqual(outcome.queue, [other])
  assert.deepEqual(outcome.abandoned, [])
})

check('a read that does not show it spends an attempt and makes it sendable again', () => {
  const waiting = entry({ id: 'a', remoteWatched: true, pushed: true, attempts: 1 })
  const outcome = verifyPushed([waiting], () => false)
  assert.deepEqual(outcome.verified, [])
  assert.deepEqual(outcome.queue, [{ ...entry({ id: 'a' }), remoteWatched: false, attempts: 2 }])
  assert.equal('pushed' in outcome.queue[0], false)
  // Local watched, remote now recorded as not: the next flush sends it.
  assert.equal(splitForFlush(outcome.queue, new Set(['a']), new Set()).sendable.length, 1)
})

check('a push Simkl keeps ignoring is given up on at the cap', () => {
  const waiting = entry({ id: 'a', remoteWatched: true, pushed: true, attempts: 4 })
  const outcome = verifyPushed([waiting], () => false, 5)
  assert.deepEqual(outcome.queue, [])
  assert.equal(outcome.abandoned.length, 1)
  assert.equal(outcome.abandoned[0].attempts, 5)
})

check('a push awaiting a read is held back from the catch-up', () => {
  const removal = entry({ id: 'a', remoteWatched: false, pushed: true })
  assert.deepEqual([...reviewRemovalsOwed([removal], [])], ['a:movie:movie'])
})

check('the list move names the completed list and the day it was watched here', () => {
  const payload = completedListPayload(
    [
      { id: 'tt4972582', type: 'movie', title: 'Split', year: '2017' },
      { id: 'tt2975590', type: 'movie', title: 'Batman v Superman', year: '2016' },
      { id: 'm-13', type: 'movie', title: 'Ex Machina', year: '2014' },
      { id: 'tt14688458', type: 'series', title: 'Silo', year: '2023' }
    ],
    (id) => (id === 'tt4972582' ? '2026-07-18T06:22:57.428Z' : undefined)
  )
  assert.equal(payload.movies?.length, 2)
  assert.deepEqual(payload.movies?.[0], {
    title: 'Split',
    year: 2017,
    ids: { imdb: 'tt4972582' },
    to: 'completed',
    watched_at: '2026-07-18T06:22:57.428Z'
  })
  assert.equal(payload.movies?.[1].watched_at, undefined)
})

check('a list move with nothing addressable is empty', () => {
  assert.deepEqual(completedListPayload([{ id: 'm-13', type: 'movie', title: 'Ex Machina' }]), {})
})

console.log(`\n${pass} passing`)
