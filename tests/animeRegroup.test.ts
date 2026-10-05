// Anime watch history following its show through a regroup — see
// animeRegroup.ts for why the rows have to move and which may.
//
// Three layers, each tested as it runs: the plan (old grouping against new,
// no database), the move itself (database.ts's moveAnimeHistory against a
// real file), and the placing of seasons stranded before any grouping was
// recorded. Then one regroup end to end: a film or an OVA leaving the shows
// it was filed in as a season, from the grouping pass to the rows. The two
// wrappers in animeSyncRepair.ts are a settings marker, a log line and a
// notification around these.
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
import {
  ANIME_GROUPED_KEY,
  animeGroupingMovedOn,
  groupAnimeCatalog,
  groupedIdsFor,
  invalidateAnimeGroupIndex,
  laterSeasons,
  resolveAnimeGroupTarget,
  regroupPlaceIsSeason
} from '../src/main/media-hub/animeSeasons'
import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import type { CatalogItem } from '../src/shared/media-hub/types'

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
async function checkAsync(name: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn()
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
  // What animeSeasons.ts's regroupPlaceIsSeason answers: s3 maps to TheTVDB
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
  // regroupPlaceIsSeason answers yes for every member of such a show; this
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

check('a front that left every show hands its rows to the one the rest went to', () => {
  // A film TheTVDB files at season 0 fronted its show by sorting first, and
  // is a title of its own now. Its rows were the show's TMDB seasons.
  const plan = planAnimeRegroup(
    [byTmdb('305074', 'film', 'one', 'two')],
    [byTmdb('305074', 'one', 'two')]
  )
  assert.deepEqual(plan.moves, [move('film', null, 'one', null)])
  assert.deepEqual(plan.ratings, [{ fromId: 'film', toId: 'one' }])
  // Not when the rest went to more than one show, or to another series.
  assert.deepEqual(
    planAnimeRegroup(
      [byTmdb('305074', 'film', 'one', 'two')],
      [byTmdb('305074', 'one'), byTmdb('305074', 'two', 'three')]
    ).moves,
    []
  )
  assert.deepEqual(
    planAnimeRegroup([byTmdb('305074', 'film', 'one', 'two')], [byTmdb('999', 'one', 'two')]).left,
    [{ id: 'film', why: 'fronted by another id, and not provably the same series' }]
  )
})

// What regroupPlaceIsSeason answers for the shows below: TheTVDB's season of
// each id in series 305074. The film and the OVA are at season 0.
const tvdbSeason: Record<string, number> = { film: 0, ova: 0, s1: 1, s2: 2, s3: 3 }
const tvdbGate = (show: string, member: string, season: number): boolean =>
  show in tvdbSeason && tvdbSeason[member] === season

check('a show numbered by TMDB that comes apart gives each season to its own entry', () => {
  // One TV season and a film: the film sorted first and fronted the show,
  // so the season was watched as film:1:N. Neither is in a show now.
  const filmFront = planAnimeRegroup([byTmdb('305074', 'film', 's1')], [], tvdbGate)
  assert.deepEqual(filmFront.moves, [move('film', 1, 's1', 1)])
  assert.deepEqual(filmFront.ratings, [{ fromId: 'film', toId: 's1' }])
  // Season 0 (the film itself among TMDB's specials) cannot be placed.
  assert.deepEqual(
    filmFront.left.map((miss) => miss.id),
    ['film']
  )

  // A first season whose second Kitsu calls an ONA: season 1 is the front's
  // own and stays; season 2 goes to the ONA's own entry.
  const ona = planAnimeRegroup([byTmdb('305074', 's1', 's2')], [], tvdbGate)
  assert.deepEqual(ona.moves, [move('s1', 2, 's2', 1)])
  assert.deepEqual(ona.ratings, [])
  assert.deepEqual(
    ona.left.map((miss) => miss.id),
    ['s1']
  )

  // With nothing to ask, nothing moves, and the show is still reported.
  const blind = planAnimeRegroup([byTmdb('305074', 'film', 's1')], [])
  assert.deepEqual(blind.moves, [])
  assert.deepEqual(
    blind.left.map((miss) => miss.id),
    ['film']
  )
})

check('a later season that becomes its season on the page brings its own rows', () => {
  // The film sat between the seasons, so s2 was at place 3, which is not
  // TheTVDB's season 2: it opened and saved as itself. With the film out,
  // its place is 2, it opens as the show, and the grid stops listing it.
  const plan = planAnimeRegroup(
    [byTmdb('305074', 's1', 'film', 's2')],
    [byTmdb('305074', 's1', 's2')],
    tvdbGate
  )
  assert.deepEqual(plan.moves, [move('s2', null, 's1', 2)])
  assert.deepEqual(plan.ratings, [{ fromId: 's2', toId: 's1' }])
  // A member whose place was already its season has its rows with the show.
  assert.deepEqual(
    planAnimeRegroup(
      [byTmdb('305074', 's1', 's2', 'ova')],
      [byTmdb('305074', 's1', 's2')],
      tvdbGate
    ).moves,
    []
  )
})

check('a film that fronted a show numbered by its members hands on its specials and rating', () => {
  // AniList dated the film before the first season, so it fronted the show.
  const plan = planAnimeRegroup([byMember('film', 's1', 's2')], [byMember('s1', 's2')])
  assert.deepEqual(plan.moves, [
    move('film', 2, 's1', 1),
    move('film', 3, 's1', 2),
    move('film', 0, 's1', 0)
  ])
  assert.deepEqual(plan.ratings, [{ fromId: 'film', toId: 's1' }])
})

check('a show numbered by TMDB that loses its front and gets it back ends where it started', () => {
  const whole = [byTmdb('305074', 'a', 'b', 'c')]
  const apart = [byTmdb('305074', 'b', 'c')]
  assert.deepEqual(planAnimeRegroup(whole, apart).moves, [move('a', null, 'b', null)])
  assert.deepEqual(planAnimeRegroup(apart, whole).moves, [move('b', null, 'a', null)])
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

// ---------------------------------------------------------------------------
// A film, an OVA or a special is not a season.
//
// groupAnimeCatalog used to merge every entry its evidence linked into the
// show as a numbered season, whatever Kitsu said the entry was. It now reads
// Kitsu's kind of entry (normalizeKitsuAnime's subtype): only TV entries are
// seasons, and the rest stay titles of their own, named on the show as
// groupedExtras. The grouping is run here as the app runs it, against a real
// database holding the lookups the pass would otherwise make, so no request
// goes out. The regroup that follows is the ledger's ordinary one.

console.log('\ngroupAnimeCatalog: only TV entries are seasons')

const NO_MAPPING = { seriesId: '', season: -1 }

/** One crawled entry, as normalizeKitsuAnime leaves it. */
function entry(id: string, subtype: string | undefined, releaseDate: string): CatalogItem {
  return {
    id,
    title: id,
    type: 'anime',
    ...(subtype ? { subtype } : {}),
    poster: '',
    background: '',
    logo: '',
    year: releaseDate.slice(0, 4),
    releaseDate,
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: []
  }
}

/**
 * A database holding every lookup the pass makes, so it makes none:
 * `tvdb` the TheTVDB mapping of each entry (absent: Kitsu has none), and
 * `edges` the Kitsu sequel/prequel links of each entry with no mapping.
 * No entry has an AniList id, so AniList is not asked either.
 */
function groupingDb(
  ids: string[],
  tvdb: Record<string, { seriesId: string; season: number }>,
  edges: Record<string, { role: 'sequel' | 'prequel'; destId: string }[]>
): Db {
  const db = tempDb()
  setDatabase(db)
  for (const id of ids) {
    const kitsuId = id.replace(/^kitsu:/, '')
    db.putCache(`kitsu:tvdb:${kitsuId}`, tvdb[id] ?? NO_MAPPING, 60_000)
    if (!tvdb[id]) db.putCache(`kitsu:edges:${kitsuId}`, edges[id] ?? [], 60_000)
  }
  return db
}

const withoutKind = (items: CatalogItem[]): CatalogItem[] =>
  items.map((item) => {
    const rest = { ...item }
    delete rest.subtype
    return rest
  })

// A show numbered by TMDB: two seasons TheTVDB maps to series 305074, and a
// film it maps to the same series' season 0 (where TheTVDB files films and
// specials). The film sorts first by its season number, so it used to front
// the show.
const TMDB_FILM = 'kitsu:31'
const TMDB_S1 = 'kitsu:32'
const TMDB_S2 = 'kitsu:33'
// A show numbered by its members: no mappings, joined by Kitsu's links.
// The first season's sequel is a film, the film's sequel the second season,
// and an OVA is a sequel of the second season.
const S1 = 'kitsu:41'
const FILM = 'kitsu:42'
const S2 = 'kitsu:43'
const OVA = 'kitsu:44'
const LONE = 'kitsu:50'

const CRAWL: CatalogItem[] = [
  entry(TMDB_S1, 'tv', '2013-04-07'),
  entry(TMDB_FILM, 'movie', '2015-07-01'),
  entry(TMDB_S2, 'tv', '2017-04-01'),
  entry(S1, 'tv', '2019-04-06'),
  entry(FILM, 'movie', '2020-10-16'),
  entry(S2, 'tv', '2021-12-05'),
  entry(OVA, 'ova', '2022-06-01'),
  entry(LONE, 'tv', '2023-09-29')
]
const TVDB = {
  [TMDB_FILM]: { seriesId: '305074', season: 0 },
  [TMDB_S1]: { seriesId: '305074', season: 1 },
  [TMDB_S2]: { seriesId: '305074', season: 2 }
}
const EDGES = {
  [S1]: [{ role: 'sequel' as const, destId: '42' }],
  [FILM]: [
    { role: 'prequel' as const, destId: '41' },
    { role: 'sequel' as const, destId: '43' }
  ],
  [S2]: [
    { role: 'prequel' as const, destId: '42' },
    { role: 'sequel' as const, destId: '44' }
  ],
  [OVA]: [{ role: 'prequel' as const, destId: '43' }]
}
const ids = (items: CatalogItem[]): string[] => items.map((item) => item.id)

/** The checks that wait on the grouping pass, run in order. */
async function groupingChecks(): Promise<void> {
  await checkAsync('a film or an OVA stays a title of its own, named on the show', async () => {
    const db = groupingDb(ids(CRAWL), TVDB, EDGES)
    const grouped = await groupAnimeCatalog(CRAWL)
    // The crawl's own order: each show where its first season was, every
    // other title where it was.
    assert.deepEqual(ids(grouped), [TMDB_S1, TMDB_FILM, S1, FILM, OVA, LONE])
    const tmdbShow = grouped[0]
    assert.deepEqual(tmdbShow.groupedIds, [TMDB_S2])
    assert.deepEqual(tmdbShow.groupedExtras, [TMDB_FILM])
    assert.deepEqual(tmdbShow.seasonStarts, ['2013-04-07', '2017-04-01'])
    assert.equal(tmdbShow.episodeCounts?.totalSeasons, 2)
    // The film between the two seasons still joins them: it is what links
    // the first season to the second. It is not one of them.
    const memberShow = grouped[2]
    assert.deepEqual(memberShow.groupedIds, [S2])
    assert.deepEqual(memberShow.groupedExtras, [FILM, OVA])
    assert.equal(grouped[5].groupedIds, undefined)
    db.close()
  })

  await checkAsync('an entry whose kind is not known is grouped as it always was', async () => {
    // A catalog cached before the kind was read: nothing tells the film from
    // a season, and taking every show apart until the next crawl would move
    // rows for nothing.
    const db = groupingDb(ids(CRAWL), TVDB, EDGES)
    const grouped = await groupAnimeCatalog(withoutKind(CRAWL))
    assert.deepEqual(ids(grouped), [TMDB_FILM, S1, LONE])
    assert.deepEqual(grouped[0].groupedIds, [TMDB_S1, TMDB_S2])
    assert.deepEqual(grouped[1].groupedIds, [FILM, S2, OVA])
    assert.equal(grouped[0].groupedExtras, undefined)
    db.close()
  })

  await checkAsync('the rows a show kept for a film go back under the film', async () => {
    const db = groupingDb(ids(CRAWL), TVDB, EDGES)
    const seriesOf = (id: string): string | null => (TVDB[id] ? TVDB[id].seriesId : '')
    const before = animeGroupRecordsOf(await groupAnimeCatalog(withoutKind(CRAWL)), seriesOf)
    followAnimeRegroup(db, before)

    // Under the old grouping: the member-numbered show's film was its season
    // 2, its second season 3 and the OVA 4. The film fronted the TMDB show,
    // whose page is TMDB's seasons whichever member sits where.
    mark(db, S1, 1, [1, 2])
    mark(db, S1, 2, [1])
    mark(db, S1, 3, [1, 2, 3])
    mark(db, S1, 4, [1])
    mark(db, TMDB_FILM, 1, [1, 2])
    mark(db, TMDB_FILM, 2, [5])

    const after = animeGroupRecordsOf(await groupAnimeCatalog(CRAWL), seriesOf)
    assert.deepEqual(after, [
      { id: TMDB_S1, members: [TMDB_S1, TMDB_S2], series: '305074' },
      { id: S1, members: [S1, S2], series: '' }
    ])
    followAnimeRegroup(db, after)

    // The film and the OVA have their own episode back, as their own titles;
    // the second season closes the gap the film left.
    assert.deepEqual(keys(db, S1), ['1:1', '1:2', '2:1', '2:2', '2:3'])
    assert.deepEqual(keys(db, FILM), ['1:1'])
    assert.deepEqual(keys(db, OVA), ['1:1'])
    // Numbered by TMDB: the rows were TMDB's seasons and stay at them, under
    // the id that fronts the same series now.
    assert.deepEqual(keys(db, TMDB_S1), ['1:1', '1:2', '2:5'])
    assert.deepEqual(keys(db, TMDB_FILM), [])
    assert.deepEqual(db.animeGroupLedger(), after)
    db.close()
  })

  await checkAsync(
    'a one-season show that was fronted by its film gets its rows back',
    async () => {
      // TheTVDB files the film at season 0, so it sorted first and fronted the
      // show: the season was watched as the film's TMDB season 1. With the film
      // out there is one season left, and no show.
      const FRONT_FILM = 'kitsu:61'
      const ONLY = 'kitsu:62'
      const crawl = [entry(FRONT_FILM, 'movie', '2016-01-01'), entry(ONLY, 'tv', '2015-01-01')]
      const tvdb = {
        [FRONT_FILM]: { seriesId: '88888', season: 0 },
        [ONLY]: { seriesId: '88888', season: 1 }
      }
      const db = groupingDb(ids(crawl), tvdb, {})
      const seriesOf = (id: string): string | null => (tvdb[id] ? tvdb[id].seriesId : '')
      const before = animeGroupRecordsOf(await groupAnimeCatalog(withoutKind(crawl)), seriesOf)
      assert.deepEqual(before, [{ id: FRONT_FILM, members: [FRONT_FILM, ONLY], series: '88888' }])
      followAnimeRegroup(db, before, regroupPlaceIsSeason)
      mark(db, FRONT_FILM, 1, [1, 2])
      mark(db, FRONT_FILM, 0, [1])

      const after = animeGroupRecordsOf(await groupAnimeCatalog(crawl), seriesOf)
      assert.deepEqual(after, [])
      const result = followAnimeRegroup(db, after, regroupPlaceIsSeason)
      assert.deepEqual(keys(db, ONLY), ['1:1', '1:2'])
      // TMDB's season 0 is not the film's own episode: it stays, and is named.
      assert.deepEqual(keys(db, FRONT_FILM), ['0:1'])
      assert.deepEqual(
        result.left.map((miss) => miss.id),
        [FRONT_FILM]
      )
      db.close()
    }
  )

  await checkAsync('what was built from the old membership is out of date', async () => {
    // The caches that depend on who the members are: the in-memory group
    // index (dropped by invalidateAnimeGroupIndex when a pass lands) and a
    // show's cached page, built with its siblings of the time and rebuilt when
    // animeGroupingMovedOn says they changed. The TheTVDB and TMDB lookups
    // themselves are per entry and per TMDB season, and do not depend on it.
    const db = groupingDb(ids(CRAWL), TVDB, EDGES)
    db.putCache('catalog:v2:anime', await groupAnimeCatalog(CRAWL), 60_000)
    db.putCache(ANIME_GROUPED_KEY, true, 60_000)
    invalidateAnimeGroupIndex()
    assert.equal(animeGroupingMovedOn(S1, [FILM, S2, OVA]), true, 'the film left the show')
    assert.equal(animeGroupingMovedOn(TMDB_FILM, [TMDB_S1, TMDB_S2]), true, 'it fronts nothing')
    assert.equal(animeGroupingMovedOn(S1, [S2]), false)
    assert.deepEqual(groupedIdsFor(S1), [S2])
    // And a film is never a later season: it opens and saves as itself.
    assert.equal(resolveAnimeGroupTarget(FILM).id, FILM)
    assert.equal(laterSeasons()?.has(FILM), false)
    assert.deepEqual(laterSeasons()?.get(S2), { id: S1, season: 2 })
    db.close()
  })
}

void groupingChecks().then(() => console.log(`\n${pass} passed`))
