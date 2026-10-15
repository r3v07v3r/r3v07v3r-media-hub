import assert from 'node:assert'
import fs from 'node:fs'
import { registerHooks } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  computeReconciliation,
  localEntryProgress,
  localSeasonEpisodeCounts,
  MAL_AWAITING_ANIME_GROUPING,
  malPushAwaitsGrouping,
  malStatusForProgress,
  planMalPushes
} from '../src/main/media-hub/mal'
import type { HistoryEntry } from '../src/shared/media-hub/types'

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

check('a season no member can be shown to be is not sent, whoever sits at that place', () => {
  // What malTitleOf hands over for a show numbered by TMDB: the member at
  // place 2 is an OVA, so season 2 of the page is blank; so is a first
  // season the show's own id cannot be shown to be.
  assert.deepEqual(
    planMalPushes(
      history,
      { id: canonical, members: ['kitsu:1', null, 'kitsu:3'] },
      { seasons: [1, 2] }
    ),
    [{ id: 'kitsu:1', watchedEpisodes: 2 }]
  )
  assert.deepEqual(
    planMalPushes(
      history,
      { id: canonical, members: [null, 'kitsu:2'] },
      { seasons: [1, 2], status: 'plan_to_watch' }
    ),
    [{ id: 'kitsu:2', watchedEpisodes: 3 }]
  )
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

check('the import counts an entry where it is kept, never at its place in the group', () => {
  // The show's rows at seasons 1 and 2, and a member kept under its own id
  // whose own page labels its episodes over three seasons.
  const own = (season: number, episode: number): ReturnType<typeof row> => ({
    ...row(season, episode),
    id: 'kitsu:7'
  })
  const local = [...history, own(1, 1), own(1, 2), own(2, 3), own(3, 4)]
  assert.deepEqual(
    localEntryProgress(
      [
        // A season of the show: that season's episodes only.
        { kitsuId: 'kitsu:1', target: { id: canonical, season: 1 } },
        { kitsuId: 'kitsu:2', target: { id: canonical, season: 2 } },
        // A title of its own: every row under its id, whatever the season.
        { kitsuId: 'kitsu:7', target: { id: 'kitsu:7', season: 1 }, whole: true },
        // Nothing held, no place, and no Kitsu id at all.
        { kitsuId: 'kitsu:3', target: { id: canonical, season: 3 } },
        { kitsuId: 'kitsu:8', target: null },
        { kitsuId: '', target: null }
      ],
      local
    ),
    { 'kitsu:1': 2, 'kitsu:2': 3, 'kitsu:7': 4, 'kitsu:3': 0 }
  )
  // Counted over season 1 alone, that title read as two episodes in and
  // the other two were pulled down from MAL a second time.
  assert.deepEqual(
    localEntryProgress([{ kitsuId: 'kitsu:7', target: { id: 'kitsu:7', season: 1 } }], local),
    { 'kitsu:7': 2 }
  )
})

check('a row with no season counts as season 1, in the preview as in the push', () => {
  // markWatched and an import store a null season when none is given. The
  // push counted such a row as season 1 and the preview dropped it, so the
  // next preview read the first season as behind MAL by exactly the
  // episodes the push had just sent, and offered to pull them again.
  const show = 'kitsu:40'
  const rows = [
    { id: show, season: 1, episode: 1 },
    { id: show, season: null, episode: 2 },
    { id: show, season: undefined, episode: 3 },
    { id: show, season: 2, episode: 1 }
  ] as unknown as HistoryEntry[]
  const pushed = planMalPushes(
    rows,
    { id: show, members: ['kitsu:41', 'kitsu:42'] },
    {
      seasons: [1]
    }
  )
  assert.deepEqual(pushed, [{ id: 'kitsu:41', watchedEpisodes: 3 }])
  assert.deepEqual(
    localEntryProgress([{ kitsuId: 'kitsu:41', target: { id: show, season: 1 } }], rows),
    { 'kitsu:41': 3 }
  )
})

check('a merged show waits for the grouping rather than send its sum to season 1', () => {
  // Before the catalog is grouped the show is one entry, so the push would
  // be the whole show's count on the first season's entry: 6 here, where
  // MAL's first season has 2. Held instead (and owed, by its error).
  const ungrouped = planMalPushes(history, { id: canonical }, { seasons: [1] })
  assert.notDeepEqual(ungrouped, [{ id: canonical, watchedEpisodes: 2 }])
  assert.equal(malPushAwaitsGrouping(history, canonical, [1], false), true)
  assert.equal(malPushAwaitsGrouping(history, canonical, [2], false), true)
  // Grouped, it goes out season by season as planMalPushes says.
  assert.equal(malPushAwaitsGrouping(history, canonical, [1], true), false)
  // A title whose rows are all its first season has the same count either
  // way, and is not held up.
  const single = [
    { id: 'kitsu:9', season: 1, episode: 1 },
    { id: 'kitsu:9', season: null, episode: 2 }
  ] as unknown as HistoryEntry[]
  assert.equal(malPushAwaitsGrouping(single, 'kitsu:9', [1], false), false)
  assert.ok(MAL_AWAITING_ANIME_GROUPING.length > 0)
})

check('an ungrouped title is one entry over every row, judged against its own total', () => {
  const pushes = planMalPushes(history, { id: canonical, totalEpisodes: 5 }, { seasons: [2] })
  assert.deepEqual(pushes, [{ id: 'kitsu:1', watchedEpisodes: 5, status: 'completed' }])
})

// The MyAnimeList Apply writes the episodes MAL is ahead by, then sends them
// to Simkl. That send used to be made once and a failure only logged; it is
// now kept in the record of owed pushes the history retry works through
// (historyRetry.ts). malSync.ts reaches Electron, so it is loaded with the
// headless stand-in, as tests/accountMarks.test.ts loads settingsStore.
async function applyOwed(): Promise<void> {
  console.log('\nthe Apply’s Simkl push')
  process.env.R3_USER_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-mal-apply-'))
  process.env.R3_ELECTRON_SHIM = '1'
  const shim = pathToFileURL(
    path.join(__dirname, '..', 'src', 'headless', 'electronShim', 'index.ts')
  )
  registerHooks({
    resolve(specifier, context, next) {
      if (specifier === 'electron') return { url: shim.href, shortCircuit: true }
      return next(specifier, context)
    }
  })
  const { createDatabase } = await import('../src/main/media-hub/database')
  const { readHistoryPending, historyRetryBatches } =
    await import('../src/main/media-hub/historyRetry')
  const { noteApplySimklPush } = await import('../src/main/media-hub/malSync')
  const db = createDatabase(path.join(process.env.R3_USER_DATA, 'apply.sqlite'), 'profile-a')
  const marks = { simkl: 'simkl-1', trakt: '', mal: 'mal-1' }
  const item = { id: 'kitsu:1', type: 'anime' as const, title: 'Show' }

  // Simkl down during the Apply: both episodes are owed, to this account.
  noteApplySimklPush(db, 'profile-a', marks, {
    item,
    season: 2,
    episodes: [3, 4],
    error: 'Simkl is down',
    now: 1000
  })
  const owed = readHistoryPending(db, 'profile-a', marks)
  assert.deepEqual(
    Object.values(owed)
      .map((entry) => [entry.service, entry.action, entry.season, entry.episode, entry.mark])
      .sort(),
    [
      ['simkl', 'add', 2, 3, 'simkl-1'],
      ['simkl', 'add', 2, 4, 'simkl-1']
    ]
  )
  // The retry picks them up as one Simkl add for the title.
  const { batches } = historyRetryBatches(owed, new Set(['kitsu:1:2:3', 'kitsu:1:2:4']))
  assert.equal(batches.length, 1)
  assert.equal(batches[0].service, 'simkl')
  assert.equal(batches[0].rows.length, 2)
  pass++
  console.log('  ok  a failed send is owed and retried')

  // Another profile's record is untouched, and a send that gets through
  // clears what an earlier one left owing.
  assert.deepEqual(readHistoryPending(db, 'profile-b', marks), {})
  noteApplySimklPush(db, 'profile-a', marks, { item, season: 2, episodes: [3, 4], now: 2000 })
  assert.deepEqual(readHistoryPending(db, 'profile-a', marks), {})
  pass++
  console.log('  ok  a send that gets through owes nothing')

  // With no Simkl account connected, nothing is kept: nobody to owe it to.
  noteApplySimklPush(
    db,
    'profile-a',
    { ...marks, simkl: '' },
    {
      item,
      season: 2,
      episodes: [5],
      error: 'not connected',
      now: 3000
    }
  )
  assert.deepEqual(readHistoryPending(db, 'profile-a', marks), {})
  pass++
  console.log('  ok  nothing is owed to an account that is not connected')
}

applyOwed()
  .catch((error) => {
    console.log(`FAIL  the Apply’s Simkl push\n      ${(error as Error).message}`)
    process.exitCode = 1
  })
  .finally(() => console.log(`\n${pass} passed`))
