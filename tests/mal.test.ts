import assert from 'node:assert'
import {
  computeReconciliation,
  localSeasonEpisodeCounts,
  malStatusForProgress,
  planMalPushes
} from '../src/main/media-hub/mal'

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

console.log('malStatusForProgress')

check('marks an anime completed when every known episode is watched', () => {
  assert.equal(malStatusForProgress(12, 12), 'completed')
  assert.equal(malStatusForProgress(13, 12), 'completed')
})

check('returns an unmarked completed anime to watching', () => {
  assert.equal(malStatusForProgress(11, 12), 'watching')
})

check('does not guess a status without a valid total', () => {
  assert.equal(malStatusForProgress(12, undefined), undefined)
  assert.equal(malStatusForProgress(12, 0), undefined)
})

console.log('\ncomputeReconciliation')

function malEntry(
  overrides: Partial<{
    malId: number
    title: string
    status: string
    watchedEpisodes: number
    score: number
    kitsuId?: string
    targetId?: string
  }> = {}
) {
  return {
    malId: 1,
    title: 'Bleach: Sennen Kessen-hen',
    status: 'watching',
    watchedEpisodes: 13,
    score: 0,
    kitsuId: 'kitsu:99999',
    targetId: 'kitsu:41',
    ...overrides
  }
}

check('compares MAL progress against the caller-supplied per-season count', () => {
  // localProgressByKitsuId is keyed by the RAW kitsuId MAL matched to (as
  // malSync.ts's localProgressByGroupTarget produces it) — this function
  // itself stays agnostic to grouping, trusting whatever count the caller
  // already resolved for that entry's real season.
  const result = computeReconciliation([malEntry({ watchedEpisodes: 13 })], { 'kitsu:99999': 5 })
  assert.equal(result.toLocal.length, 1)
  assert.equal(result.toLocal[0].fromEpisode, 6)
  assert.equal(result.toLocal[0].toEpisode, 13)
})

check('pulls a MAL rating into local when the target has no local rating yet', () => {
  const result = computeReconciliation(
    [malEntry({ score: 8, watchedEpisodes: 13 })],
    { 'kitsu:99999': 13 },
    {}
  )
  assert.equal(result.ratingsToLocal.length, 1)
  assert.equal(result.ratingsToLocal[0].targetId, 'kitsu:41')
  assert.equal(result.ratingsToLocal[0].score, 8)
})

check('never overwrites a rating that already exists locally', () => {
  const result = computeReconciliation(
    [malEntry({ score: 8, watchedEpisodes: 13 })],
    { 'kitsu:99999': 13 },
    { 'kitsu:41': 6 }
  )
  assert.equal(result.ratingsToLocal.length, 0)
})

check('ignores an unrated MAL entry for ratings, even with a matched target', () => {
  const result = computeReconciliation(
    [malEntry({ score: 0, watchedEpisodes: 13 })],
    { 'kitsu:99999': 13 },
    {}
  )
  assert.equal(result.ratingsToLocal.length, 0)
})

check('an unmatched MAL entry is reported, not silently dropped', () => {
  const entry = malEntry({ kitsuId: undefined, targetId: undefined, score: 7 })
  const result = computeReconciliation([entry], {}, {})
  assert.equal(result.unmatched.length, 1)
  assert.equal(result.ratingsToLocal.length, 0)
})

console.log('\nplanMalPushes')

const canonical = 'kitsu:1'
const members = ['kitsu:1', 'kitsu:2', 'kitsu:3']
const row = (
  season: number,
  episode: number,
  watchedAt = '2026-01-01T00:00:00.000Z'
): { id: string; type: 'anime'; season: number; episode: number; watchedAt: string } => ({
  id: canonical,
  type: 'anime',
  season,
  episode,
  watchedAt
})
const history = [
  row(1, 1),
  row(1, 2),
  row(1, 2, '2026-02-01T00:00:00.000Z'),
  row(2, 1),
  row(2, 2),
  row(2, 3)
]

check('a season counts each episode once, however often it was watched', () => {
  assert.deepEqual(
    [...localSeasonEpisodeCounts(history, canonical)],
    [
      [1, 2],
      [2, 3]
    ]
  )
  assert.deepEqual([...localSeasonEpisodeCounts(history, 'kitsu:9')], [])
})

check(
  'a grouped title goes to one entry per touched season, each with its own count and total',
  () => {
    const pushes = planMalPushes(
      history,
      { id: canonical, members, totalEpisodes: 25 },
      {
        seasons: [2, 1],
        seasonTotals: new Map([
          [1, 2],
          [2, 13]
        ])
      }
    )
    assert.deepEqual(pushes, [
      { id: 'kitsu:1', watchedEpisodes: 2, status: 'completed' },
      { id: 'kitsu:2', watchedEpisodes: 3, status: 'watching' }
    ])
  }
)

check('a season the change did not touch is not written, and one with no member is skipped', () => {
  const pushes = planMalPushes(history, { id: canonical, members }, { seasons: [2, 4, 0] })
  assert.deepEqual(pushes, [{ id: 'kitsu:2', watchedEpisodes: 3 }])
})

check("the group's total never judges a member; without its own, a member gets no status", () => {
  const pushes = planMalPushes(
    history,
    { id: canonical, members, totalEpisodes: 2 },
    { seasons: [1] }
  )
  assert.deepEqual(pushes, [{ id: 'kitsu:1', watchedEpisodes: 2 }])
})

check(
  'a planned clear says plan_to_watch to each touched entry at zero, and nothing otherwise',
  () => {
    const planned = planMalPushes(
      [],
      { id: canonical, members },
      { seasons: [1, 2], status: 'plan_to_watch' }
    )
    assert.deepEqual(planned, [
      { id: 'kitsu:1', watchedEpisodes: 0, status: 'plan_to_watch' },
      { id: 'kitsu:2', watchedEpisodes: 0, status: 'plan_to_watch' }
    ])
    assert.deepEqual(planMalPushes([], { id: canonical, members }, { seasons: [1] }), [
      { id: 'kitsu:1', watchedEpisodes: 0 }
    ])
  }
)

check('an ungrouped title is one entry over every row, judged against its own total', () => {
  const pushes = planMalPushes(history, { id: canonical, totalEpisodes: 5 }, { seasons: [2] })
  assert.deepEqual(pushes, [{ id: 'kitsu:1', watchedEpisodes: 5, status: 'completed' }])
})

console.log(`\n${pass} passed`)
