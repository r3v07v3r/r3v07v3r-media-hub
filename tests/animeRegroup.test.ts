// Anime watch history following its show through a regroup — see
// animeRegroup.ts for why the rows have to move and which may.
//
// Three layers, each tested as it runs: the plan (old grouping against new,
// no database), the move itself (database.ts's moveAnimeHistory against a
// real file), and the placing of seasons stranded before any grouping was
// recorded. The two wrappers in animeSyncRepair.ts are a settings marker,
// a log line and a notification around these.
//
// Run with: npx tsx tests/animeRegroup.test.ts   (or npm.cmd test)

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  animeGroupRecordsOf,
  followAnimeRegroup,
  placeStrandedSeasons,
  planAnimeRegroup,
  strandedSeasonMoves,
  type AnimeGroupRecord
} from '../src/main/media-hub/animeRegroup'
import { createDatabase } from '../src/main/media-hub/database'

const PROFILE = 'profile-one'
const OTHER = 'profile-two'

function tempDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-anime-regroup-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}
type Db = ReturnType<typeof tempDb>

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

/** A show numbered by its members: no TheTVDB mapping. */
const byMember = (...members: string[]): AnimeGroupRecord => ({
  id: members[0],
  members,
  series: ''
})
/** A show whose page is numbered by TMDB seasons. */
const byTmdb = (series: string | null, ...members: string[]): AnimeGroupRecord => ({
  id: members[0],
  members,
  series
})

const move = (
  fromId: string,
  fromSeason: number | null,
  toId: string,
  toSeason: number | null
) => ({
  fromId,
  fromSeason,
  toId,
  toSeason
})

console.log('planAnimeRegroup')

check('the same grouping twice needs nothing', () => {
  const groups = [byMember('a', 'b', 'c'), byTmdb('305074', 'x', 'y')]
  assert.deepEqual(planAnimeRegroup(groups, groups), { moves: [], ratings: [], left: [] })
})

check('two seasons changing places each follow their member', () => {
  const plan = planAnimeRegroup([byMember('a', 'b', 'c')], [byMember('a', 'c', 'b')])
  assert.deepEqual(plan.moves, [move('a', 2, 'a', 3), move('a', 3, 'a', 2)])
  assert.deepEqual(plan.ratings, [])
})

// The shape found in a real library: the id that fronted the show is its
// last season now, and the rest came out in another order.
check('a show fronted by another id moves every season, its specials and its rating', () => {
  const plan = planAnimeRegroup(
    [byMember('hashira', 'first', 'movie', 'district', 'train', 'village')],
    [byMember('first', 'movie', 'train', 'district', 'village', 'hashira')]
  )
  assert.deepEqual(plan.moves, [
    move('hashira', 1, 'first', 6),
    move('hashira', 2, 'first', 1),
    move('hashira', 3, 'first', 2),
    // Season 4 keeps its number and still has to change ids.
    move('hashira', 4, 'first', 4),
    move('hashira', 5, 'first', 3),
    move('hashira', 6, 'first', 5),
    move('hashira', 0, 'first', 0)
  ])
  assert.deepEqual(plan.ratings, [{ fromId: 'hashira', toId: 'first' }])
  assert.deepEqual(plan.left, [])
})

check('a member that left the show takes its season back under its own id', () => {
  const plan = planAnimeRegroup([byMember('a', 'b', 'c', 'd')], [byMember('a', 'c', 'd')])
  assert.deepEqual(plan.moves, [
    move('a', 2, 'b', 1),
    // The seasons after it close the gap it left.
    move('a', 3, 'a', 2),
    move('a', 4, 'a', 3)
  ])
})

check('a show that came apart leaves its first season where it is', () => {
  const plan = planAnimeRegroup([byMember('a', 'b', 'c')], [])
  assert.deepEqual(plan.moves, [move('a', 2, 'b', 1), move('a', 3, 'c', 1)])
  assert.deepEqual(plan.ratings, [], 'the rating stays with the id that fronted it')
})

check('an id that stood alone joins a show at its position, whatever season it carried', () => {
  const plan = planAnimeRegroup([byMember('a', 'c')], [byMember('a', 'b', 'c')])
  assert.deepEqual(plan.moves, [
    move('a', 2, 'a', 3),
    // fromSeason null: every row under b is that one entry's.
    move('b', null, 'a', 2)
  ])
  assert.deepEqual(plan.ratings, [{ fromId: 'b', toId: 'a' }])
})

check('an id that stood alone and now fronts a show keeps its own episodes as season 1', () => {
  const plan = planAnimeRegroup([], [byMember('a', 'b')])
  assert.deepEqual(plan.moves, [move('a', null, 'a', 1), move('b', null, 'a', 2)])
})

console.log('\nplanAnimeRegroup, a show numbered by TMDB')

check('a new order moves nothing: season N on the page is still TMDB season N', () => {
  const plan = planAnimeRegroup(
    [byTmdb('305074', 's1', 's2', 's3', 's4')],
    [byTmdb('305074', 's1', 's2', 'ova', 's3', 's4')]
  )
  // Not even the id that joined. Its place is 3 and season 3 of the page is
  // TMDB's third season, not this OVA: moved there, its rows would mark
  // that season watched. It still opens and saves as itself.
  assert.deepEqual(plan.moves, [])
  assert.deepEqual(plan.left, [])
})

check('an id that joins a TMDB-numbered show moves only where its place is its season', () => {
  const before = [byTmdb('305074', 's1', 's2')]
  const after = [byTmdb('305074', 's1', 's2', 's3', 'ova')]
  // What animeSeasons.ts's seasonMatchesPage answers: s3 maps to TheTVDB
  // season 3 and sits at place 3; the OVA at place 4 maps to nothing.
  const placeIsSeason = (show: string, member: string, season: number): boolean =>
    show === 's1' && member === 's3' && season === 3
  assert.deepEqual(planAnimeRegroup(before, after, placeIsSeason).moves, [
    move('s3', null, 's1', 3)
  ])
  assert.deepEqual(planAnimeRegroup(before, after, placeIsSeason).ratings, [
    { fromId: 's3', toId: 's1' }
  ])
  // With nothing to ask, only a show numbered by its members is known to
  // keep a later season at its place.
  assert.deepEqual(planAnimeRegroup(before, after).moves, [])
  assert.deepEqual(planAnimeRegroup([byMember('a')], [byMember('a', 'b')]).moves, [
    move('b', null, 'a', 2)
  ])
})

check('the rule is asked of a show numbered by its members too, and can say no', () => {
  // seasonMatchesPage answers yes for every member of such a show; this
  // only pins that the answer given is the one obeyed.
  const plan = planAnimeRegroup([byMember('a', 'c')], [byMember('a', 'b', 'c')], () => false)
  assert.deepEqual(plan.moves, [move('a', 2, 'a', 3)])
})

check('another id fronting the same series takes every row, at the season it has', () => {
  const plan = planAnimeRegroup(
    [byTmdb('305074', 's2', 's3')],
    [byTmdb('305074', 's1', 's2', 's3')]
  )
  // Both nulls: every season, kept as it is. And nothing for s1 itself: it
  // fronts a show whose season 1 is TMDB's, not its own entry's.
  assert.deepEqual(plan.moves, [move('s2', null, 's1', null)])
  assert.deepEqual(plan.ratings, [{ fromId: 's2', toId: 's1' }])
})

check('another id fronting a different or unknown series is left, and said so', () => {
  for (const after of [byTmdb('999', 's1', 's2'), byTmdb(null, 's1', 's2'), byMember('s1', 's2')]) {
    const plan = planAnimeRegroup([byTmdb('305074', 's2', 's3')], [after])
    assert.deepEqual(
      plan.moves.filter((m) => m.fromId === 's2'),
      []
    )
    assert.equal(plan.left.length, 1)
    assert.equal(plan.left[0].id, 's2')
  }
})

check('a show whose lookup never answered is not treated as numbered by members', () => {
  const plan = planAnimeRegroup([byTmdb(null, 'a', 'b', 'c')], [byTmdb(null, 'a', 'c', 'b')])
  assert.deepEqual(plan.moves, [])
})

check('a show that gained a mapping between two passes is left, not moved by member', () => {
  const plan = planAnimeRegroup([byMember('a', 'b', 'c')], [byTmdb('305074', 'a', 'c', 'b')])
  assert.deepEqual(plan.moves, [])
  assert.deepEqual(plan.left.map((miss) => miss.id).sort(), ['b', 'c'])
})

console.log('\nanimeGroupRecordsOf')

check('only merged shows are recorded, sorted, with the series of the id in front', () => {
  const records = animeGroupRecordsOf(
    [
      { id: 'kitsu:9', groupedIds: ['kitsu:10'] },
      { id: 'kitsu:5' },
      { id: 'kitsu:1', groupedIds: ['kitsu:2', 'kitsu:3'] }
    ],
    (id) => (id === 'kitsu:1' ? '305074' : id === 'kitsu:9' ? '' : null)
  )
  assert.deepEqual(records, [
    { id: 'kitsu:1', members: ['kitsu:1', 'kitsu:2', 'kitsu:3'], series: '305074' },
    { id: 'kitsu:9', members: ['kitsu:9', 'kitsu:10'], series: '' }
  ])
})

console.log('\nmoveAnimeHistory')

const anime = (id: string) => ({ id, type: 'anime' as const, title: id })
const keys = (db: Db, id: string): string[] =>
  db
    .history()
    .filter((h) => h.id === id)
    .map((h) => `${h.season}:${h.episode}`)
    .sort()
const mark = (db: Db, id: string, season: number, episodes: number[]): void => {
  for (const episode of episodes) db.markWatched(anime(id), { season, episode })
}

// The reason every move is lifted out before any is put down. Done one at
// a time, season 2's rows would land on season 3's before those had left,
// and the primary key would drop them.
check('two seasons changing places lose nothing', () => {
  const db = tempDb()
  mark(db, 'a', 1, [1])
  mark(db, 'a', 2, [1, 2, 3])
  mark(db, 'a', 3, [1, 2])

  const landed = db.moveAnimeHistory(
    planAnimeRegroup([byMember('a', 'b', 'c')], [byMember('a', 'c', 'b')])
  )

  assert.equal(landed.history, 5)
  assert.deepEqual(keys(db, 'a'), ['1:1', '2:1', '2:2', '3:1', '3:2', '3:3'])
  // The same play ids, on the new seasons.
  assert.equal(db.plays().filter((p) => p.season === 3).length, 3)
  assert.equal(db.plays().length, 6)
})

check('a show fronted by another id is whole under the new one, for every profile', () => {
  const db = tempDb()
  const before = byMember('hashira', 'first', 'movie', 'district', 'train', 'village')
  const after = byMember('first', 'movie', 'train', 'district', 'village', 'hashira')
  mark(db, 'hashira', 1, [1, 2])
  mark(db, 'hashira', 2, [1, 2, 3])
  mark(db, 'hashira', 3, [1])
  mark(db, 'hashira', 5, [1, 2])
  db.setActiveProfile(OTHER)
  mark(db, 'hashira', 4, [7])

  db.moveAnimeHistory(planAnimeRegroup([before], [after]))

  assert.deepEqual(keys(db, 'hashira'), [])
  assert.deepEqual(keys(db, 'first'), ['4:7'], 'the profile nobody had open')
  db.setActiveProfile(PROFILE)
  assert.deepEqual(keys(db, 'hashira'), [])
  assert.deepEqual(keys(db, 'first'), ['1:1', '1:2', '1:3', '2:1', '3:1', '3:2', '6:1', '6:2'])
  // Reachable by the key the normal lookup builds, and saying what they are.
  assert.equal(db.history().find((h) => h.id === 'first')?.type, 'anime')
  assert.equal(db.unmarkWatched('first', 6, 2), true)
})

check('a row already at the destination is kept, and the arriving copy dropped', () => {
  const db = tempDb()
  db.importWatched([
    { ...anime('first'), season: 1, episode: 1, watchedAt: '2026-09-05T10:00:00.000Z' },
    { ...anime('hashira'), season: 2, episode: 1, watchedAt: '2026-08-24T10:00:00.000Z' },
    { ...anime('hashira'), season: 2, episode: 2, watchedAt: '2026-08-24T10:00:01.000Z' }
  ])

  const landed = db.moveAnimeHistory({ moves: [move('hashira', 2, 'first', 1)] })

  assert.equal(landed.history, 1, 'episode 2 only')
  const first = db.history().filter((h) => h.id === 'first')
  assert.equal(first.find((h) => h.episode === 1)?.watchedAt, '2026-09-05T10:00:00.000Z')
  // Both viewings of episode 1 happened, so both plays are kept.
  assert.equal(db.plays().filter((p) => p.contentId === 'first' && p.episode === 1).length, 2)
  assert.equal(db.plays().filter((p) => p.contentId === 'hashira').length, 0)
})

check('the same viewing arriving twice is one play', () => {
  const db = tempDb()
  const at = '2026-08-24T10:00:00.000Z'
  db.importWatched([
    { ...anime('first'), season: 1, episode: 1, watchedAt: at },
    { ...anime('hashira'), season: 2, episode: 1, watchedAt: at }
  ])

  db.moveAnimeHistory({ moves: [move('hashira', 2, 'first', 1)] })

  assert.equal(db.plays().length, 1)
})

check('resume points move with their episodes', () => {
  const db = tempDb()
  db.savePlaybackPosition('a', { season: 2, episode: 4 }, 300, 1400)
  db.savePlaybackPosition('a', { season: 3, episode: 4 }, 600, 1400)

  const landed = db.moveAnimeHistory(
    planAnimeRegroup([byMember('a', 'b', 'c')], [byMember('a', 'c', 'b')])
  )

  assert.equal(landed.positions, 2)
  assert.equal(db.getPlaybackPosition('a', { season: 3, episode: 4 })?.positionSeconds, 300)
  assert.equal(db.getPlaybackPosition('a', { season: 2, episode: 4 })?.positionSeconds, 600)
})

check('a rating follows the show, and never replaces one already given', () => {
  const db = tempDb()
  db.rate('hashira', 9)
  db.moveAnimeHistory({ moves: [], ratings: [{ fromId: 'hashira', toId: 'first' }] })
  assert.equal(db.ratings().get('first'), 9)
  assert.equal(db.ratings().get('hashira'), undefined)

  db.rate('other', 4)
  db.moveAnimeHistory({ moves: [], ratings: [{ fromId: 'other', toId: 'first' }] })
  assert.equal(db.ratings().get('first'), 9)
})

// WATCHLIST-SYNC.md, "A later season under its own id": the id on a plan
// row names the entry at the service, so a removal can only reach that one.
check('a planned title stays on the plan under its own id', () => {
  const db = tempDb()
  db.track(anime('hashira'))
  mark(db, 'hashira', 1, [1])

  db.moveAnimeHistory(
    planAnimeRegroup([byMember('hashira', 'first')], [byMember('first', 'hashira')])
  )

  assert.equal(db.isTracked('hashira'), true)
  assert.equal(db.isTracked('first'), false)
  assert.deepEqual(keys(db, 'first'), ['2:1'])
})

check('an id that stood alone lands on one season, whatever seasons it carried', () => {
  const db = tempDb()
  // Kitsu's labels inside one long entry, episodes numbered across it.
  mark(db, 'b', 1, [1, 2])
  mark(db, 'b', 2, [3])
  db.markWatched(anime('b'))

  db.moveAnimeHistory({ moves: [move('b', null, 'a', 2)] })

  assert.deepEqual(keys(db, 'a'), ['2:1', '2:2', '2:3'])
  assert.deepEqual(keys(db, 'b'), ['null:null'], 'a row with no episode is not an episode')
})

check('an id whose rows are a whole show gives up only its season 1 that way', () => {
  const db = tempDb()
  mark(db, 'b', 1, [1, 2])
  mark(db, 'b', 2, [1])

  db.moveAnimeHistory({ moves: [move('b', null, 'a', 3)] })

  assert.deepEqual(keys(db, 'a'), ['3:1', '3:2'])
  assert.deepEqual(keys(db, 'b'), ['2:1'])
})

check('an id that now fronts a show has its own episodes at season 1', () => {
  const db = tempDb()
  mark(db, 'a', 3, [1, 2])
  mark(db, 'b', 1, [1])

  db.moveAnimeHistory(planAnimeRegroup([], [byMember('a', 'b')]))

  assert.deepEqual(keys(db, 'a'), ['1:1', '1:2', '2:1'])
})

check('every row under an id follows it at the season it has, specials included', () => {
  const db = tempDb()
  mark(db, 's2', 0, [1])
  mark(db, 's2', 1, [1, 2])
  mark(db, 's2', 4, [9])

  db.moveAnimeHistory(
    planAnimeRegroup([byTmdb('305074', 's2', 's3')], [byTmdb('305074', 's1', 's2', 's3')])
  )

  assert.deepEqual(keys(db, 's2'), [])
  assert.deepEqual(keys(db, 's1'), ['0:1', '1:1', '1:2', '4:9'])
})

check('a move with no usable season, or to where the rows already are, changes nothing', () => {
  const db = tempDb()
  mark(db, 'a', 2, [1])

  for (const bad of [
    move('a', 2, 'a', 2),
    move('a', 1.5, 'b', 1),
    move('a', 2, 'b', -1),
    move('a', 2, 'b', null),
    move('a', null, 'a', null),
    move('', 2, 'b', 1)
  ]) {
    assert.equal(db.moveAnimeHistory({ moves: [bad] }).history, 0)
  }
  assert.deepEqual(keys(db, 'a'), ['2:1'])
})

console.log('\nfollowAnimeRegroup')

check('the first grouping is recorded and moves nothing', () => {
  const db = tempDb()
  mark(db, 'b', 1, [1])
  assert.equal(db.animeGroupLedger(), null)

  const result = followAnimeRegroup(db, [byMember('a', 'b')])

  assert.equal(result.moved, 0)
  assert.deepEqual(db.animeGroupLedger(), [byMember('a', 'b')])
  assert.deepEqual(keys(db, 'b'), ['1:1'], 'rows from before the ledger are the repair’s to place')
})

check('a later grouping moves the rows and becomes the one on record', () => {
  const db = tempDb()
  followAnimeRegroup(db, [byMember('hashira', 'first')])
  mark(db, 'hashira', 1, [1, 2])
  mark(db, 'hashira', 2, [1])

  const result = followAnimeRegroup(db, [byMember('first', 'hashira')])

  // Three history rows and their three plays.
  assert.equal(result.moved, 6)
  assert.deepEqual(keys(db, 'first'), ['1:1', '2:1', '2:2'])
  assert.deepEqual(db.animeGroupLedger(), [byMember('first', 'hashira')])
  // And asked again with the same grouping, there is nothing to do.
  assert.equal(followAnimeRegroup(db, [byMember('first', 'hashira')]).moved, 0)
  assert.deepEqual(keys(db, 'first'), ['1:1', '2:1', '2:2'])
})

check('a show that splits and comes back together ends where it started', () => {
  const db = tempDb()
  const whole = [byMember('a', 'b', 'c', 'd')]
  followAnimeRegroup(db, whole)
  mark(db, 'a', 1, [1])
  mark(db, 'a', 2, [1, 2])
  mark(db, 'a', 3, [1])
  mark(db, 'a', 4, [1, 2, 3])
  const started = keys(db, 'a')

  // A pass whose lookups for the middle of the chain failed.
  followAnimeRegroup(db, [byMember('a', 'b'), byMember('c', 'd')])
  assert.deepEqual(keys(db, 'a'), ['1:1', '2:1', '2:2'])
  assert.deepEqual(keys(db, 'c'), ['1:1', '2:1', '2:2', '2:3'])

  followAnimeRegroup(db, whole)
  assert.deepEqual(keys(db, 'a'), started)
  assert.deepEqual(keys(db, 'c'), [])
})

console.log('\nplaceStrandedSeasons')

// The two shapes found in a real library, 2026-10-04.
const demonSlayer = {
  id: 'hashira',
  seasons: [
    { season: 1, episodes: 8, first: 1, last: 8 },
    { season: 2, episodes: 26, first: 1, last: 26 },
    { season: 3, episodes: 1, first: 1, last: 1 },
    { season: 4, episodes: 11, first: 1, last: 11 },
    { season: 5, episodes: 7, first: 1, last: 7 },
    { season: 6, episodes: 11, first: 1, last: 11 }
  ],
  members: [
    { id: 'first', episodes: 26 },
    { id: 'movie', episodes: 1 },
    { id: 'train', episodes: 7 },
    { id: 'district', episodes: 11 },
    { id: 'village', episodes: 11 },
    { id: 'hashira', episodes: 8 }
  ]
}

check('by length alone, every season has to be placed or none is', () => {
  // Two members have eleven episodes and nothing says which was which. With
  // those two unexplained, 26, 1 and 7 matching is not trusted either.
  const result = placeStrandedSeasons(demonSlayer)
  assert.deepEqual(result.placed, [])
  assert.deepEqual(
    result.left.map((miss) => miss.season),
    [2, 3, 4, 5, 6]
  )

  // Without the two elevens, every season under the id has one member.
  const three = placeStrandedSeasons({
    ...demonSlayer,
    seasons: demonSlayer.seasons.filter((held) => held.episodes !== 11)
  })
  assert.deepEqual(three.placed, [
    { season: 2, member: 'first' },
    { season: 3, member: 'movie' },
    { season: 5, member: 'train' }
  ])
  assert.deepEqual(three.left, [])
})

check('the order the index remembers tells two members of one length apart', () => {
  const result = placeStrandedSeasons({
    ...demonSlayer,
    remembered: ['first', 'movie', 'district', 'train', 'village']
  })
  assert.deepEqual(result.placed, [
    { season: 2, member: 'first' },
    { season: 3, member: 'movie' },
    { season: 4, member: 'district' },
    { season: 5, member: 'train' },
    { season: 6, member: 'village' }
  ])
  assert.deepEqual(result.left, [])
})

check('a remembered order the rows contradict is set aside whole', () => {
  // It names the one-episode film for season 2, which holds 26 episodes:
  // not the order these rows were written in, so it breaks no ties either.
  const result = placeStrandedSeasons({
    ...demonSlayer,
    remembered: ['movie', 'first', 'district', 'train', 'village']
  })
  assert.deepEqual(result.placed, [])
})

check('a remembered order naming an id that is no part of the show is set aside', () => {
  const result = placeStrandedSeasons({
    ...demonSlayer,
    remembered: ['first', 'movie', 'district', 'train', 'gone']
  })
  assert.deepEqual(result.placed, [])
})

check('with a believed order, a season watched in part is left and the rest are placed', () => {
  const result = placeStrandedSeasons({
    ...demonSlayer,
    seasons: demonSlayer.seasons.map((held) =>
      held.season === 6 ? { season: 6, episodes: 4, first: 1, last: 4 } : held
    ),
    remembered: ['first', 'movie', 'district', 'train', 'village']
  })
  assert.deepEqual(
    result.placed.map((place) => place.season),
    [2, 3, 4, 5]
  )
  assert.deepEqual(
    result.left.map((miss) => miss.season),
    [6]
  )
})

check('by length alone, a season watched in part leaves all of them', () => {
  const result = placeStrandedSeasons({
    id: 'x',
    seasons: [
      { season: 2, episodes: 5, first: 1, last: 5 },
      { season: 3, episodes: 12, first: 1, last: 13 }
    ],
    members: [
      { id: 'x', episodes: 12 },
      { id: 'a', episodes: 5 },
      { id: 'b', episodes: 13 }
    ],
    remembered: ['b', 'a']
  })
  // Season 2's five could be all of `a` or the start of `b`; the order
  // remembered says `b`, and five of thirteen proves nothing.
  assert.deepEqual(result.placed, [])
  assert.equal(result.left.length, 2)
})

check('two seasons that fit one member are both left', () => {
  const result = placeStrandedSeasons({
    id: 'x',
    seasons: [
      { season: 2, episodes: 12, first: 1, last: 12 },
      { season: 3, episodes: 12, first: 1, last: 12 }
    ],
    members: [
      { id: 'x', episodes: 24 },
      { id: 'a', episodes: 12 },
      { id: 'b', episodes: null }
    ]
  })
  assert.deepEqual(result.placed, [])
  assert.deepEqual(
    result.left.map((miss) => miss.season),
    [2, 3]
  )
})

check('the id itself is never where its own later season goes', () => {
  const result = placeStrandedSeasons({
    id: 'x',
    seasons: [{ season: 2, episodes: 12, first: 1, last: 12 }],
    members: [
      { id: 'x', episodes: 12 },
      { id: 'a', episodes: 13 }
    ]
  })
  assert.deepEqual(result.placed, [])
})

console.log('\nstrandedSeasonMoves')

const soloLeveling = byMember('first', 'arise')
const lengths = new Map([
  ['first', 12],
  ['arise', 13]
])
const range = (n: number): number[] => Array.from({ length: n }, (_, i) => i + 1)

check('the whole repair: the id’s own season, then the ones that can be placed', () => {
  const db = tempDb()
  // `arise` fronted the show when these were written: itself, then `first`.
  mark(db, 'arise', 1, range(13))
  mark(db, 'arise', 2, range(12))
  // Somebody else only ever watched it from the season's own page.
  db.setActiveProfile(OTHER)
  mark(db, 'arise', 2, [1, 2])
  db.setActiveProfile(PROFILE)

  const stranded = strandedSeasonMoves(db, 'arise', {
    group: soloLeveling,
    episodesOf: (member) => lengths.get(member) ?? null
  })
  assert.deepEqual(stranded.moves, [
    { fromId: 'arise', fromSeason: 2, toId: 'first', toSeason: 1, profileId: PROFILE }
  ])
  // As the repair runs them: the remap first, then the placed seasons.
  db.remapContentIds([{ fromId: 'arise', toId: 'first', season: 2 }])
  db.moveAnimeHistory({ moves: stranded.moves })

  assert.deepEqual(keys(db, 'arise'), [])
  assert.equal(keys(db, 'first').filter((key) => key.startsWith('1:')).length, 12)
  assert.equal(keys(db, 'first').filter((key) => key.startsWith('2:')).length, 13)
  db.setActiveProfile(OTHER)
  // One entry's rows, so all of it is the second season: the remap's rule.
  assert.deepEqual(keys(db, 'first'), ['2:1', '2:2'])
})

check('nothing is placed on a show numbered by TMDB seasons', () => {
  const db = tempDb()
  mark(db, 'arise', 1, range(13))
  mark(db, 'arise', 2, range(12))

  const stranded = strandedSeasonMoves(db, 'arise', {
    group: byTmdb('305074', 'first', 'arise'),
    episodesOf: (member) => lengths.get(member) ?? null
  })

  assert.deepEqual(stranded.moves, [])
  assert.equal(stranded.left.length, 1)
})

check('an id holding one entry’s rows has nothing stranded', () => {
  const db = tempDb()
  mark(db, 'arise', 1, [1, 2, 3])

  const stranded = strandedSeasonMoves(db, 'arise', {
    group: soloLeveling,
    episodesOf: () => {
      throw new Error('not asked for')
    }
  })

  assert.deepEqual(stranded, { moves: [], left: [] })
})

console.log(`\n${pass} passed`)
