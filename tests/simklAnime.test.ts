// Anime between this app and Simkl: one merged show here, an entry per
// season there.
//
// Watch history is keyed on a franchise's canonical Kitsu id with the season
// as the member's place in the group. Simkl keeps one entry per season, each
// numbered from 1. This pins the translation in both directions
// (serviceIds.ts), the request bodies built on it (simkl.ts), and that the
// phone's catch-up (simklCatchUpRules.ts) reads back exactly what a push
// sent.
//
// NOTHING HERE TALKS TO SIMKL. The "account" below is a model of what
// Simkl's anime guide describes — an entry per anime id, episodes numbered
// flat within it — not Simkl. It proves the two halves of this app agree
// with each other and with that description; whether Simkl behaves as its
// guide says is not something this file can show.
//
// Run with: npx tsx tests/simklAnime.test.ts

import assert from 'node:assert/strict'

import { animeGroupIndexesOf, laterSeasonsOf } from '../src/main/media-hub/animeSeasons'
import {
  batchHistoryPayload,
  hasSimklContent,
  historyPayload,
  scrobblePayload,
  seasonHistoryPayload,
  titleHistoryPayload,
  type SimklHistoryPayload
} from '../src/main/media-hub/simkl'
import {
  parseSimklLibrary,
  planCatchUp,
  type CatchUpLocal,
  type ResolvedTitle
} from '../src/main/media-hub/simklCatchUpRules'
import { bySeason } from '../src/main/media-hub/titleStatusRules'
import {
  animeEntryTarget,
  animeHistoryCoordinates,
  animeSeasonMembers,
  animeSeasonOf,
  animeSeasonOfMember,
  animeTvdbSeasonIs,
  fromSimklAnimeEpisode,
  toSimklAnimeEpisode,
  type AnimeGroupOf,
  type AnimeGroupTarget,
  type AnimeSeasonMembers,
  type AnimeTvdbSeason,
  type LocalAnimeEpisode
} from '../src/shared/media-hub/serviceIds'

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

// One franchise merged into one show — three seasons, each its own Kitsu id
// and so its own Simkl entry — and one title that was never merged. Both
// lookups come from the construction the app itself runs on.
const SHOW = 'kitsu:100'
const SEASON_2 = 'kitsu:200'
const SEASON_3 = 'kitsu:300'
const ALONE = 'kitsu:900'
const { siblings, positions } = animeGroupIndexesOf([
  { id: SHOW, groupedIds: [SEASON_2, SEASON_3] },
  { id: ALONE }
])
// The seasons of a show built from its members are its members, in order.
const membersOf: AnimeSeasonMembers = (id) => {
  const later = siblings.get(id)
  return later ? [id, ...later] : undefined
}
// resolveAnimeGroupTarget's own fallback: an id in no group is itself, at
// season 1.
const targetOf: AnimeGroupTarget = (id) => positions.get(id) ?? { id, season: 1 }

const show = { id: SHOW, type: 'anime' as const, title: 'Bleach', year: '2004' }
const alone = { id: ALONE, type: 'anime' as const, title: 'Frieren', year: '2023' }

// ---------------------------------------------------------------------------
console.log('animeGroupIndexesOf')

check('the canonical id is season 1 and each sibling the next, in order', () => {
  assert.deepEqual(targetOf(SHOW), { id: SHOW, season: 1 })
  assert.deepEqual(targetOf(SEASON_2), { id: SHOW, season: 2 })
  assert.deepEqual(targetOf(SEASON_3), { id: SHOW, season: 3 })
  assert.deepEqual(siblings.get(SHOW), [SEASON_2, SEASON_3])
  assert.deepEqual(membersOf(SHOW), [SHOW, SEASON_2, SEASON_3])
})

check('only the canonical id fronts a group', () => {
  assert.equal(membersOf(SEASON_2), undefined)
  assert.equal(membersOf(ALONE), undefined)
  assert.equal(positions.has(ALONE), false)
})

// ---------------------------------------------------------------------------
console.log('\ntoSimklAnimeEpisode')

check("season 2 episode 5 is episode 5 of the second season's own entry", () => {
  assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season: 2, episode: 5 }, membersOf), {
    id: SEASON_2,
    episode: 5
  })
  assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season: 3, episode: 1 }, membersOf), {
    id: SEASON_3,
    episode: 1
  })
})

check("season 1, or no season, is the id's own entry", () => {
  for (const season of [1, undefined, null]) {
    assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season, episode: 5 }, membersOf), {
      id: SHOW,
      episode: 5
    })
  }
})

check('a special, and a season the group has no member for, have no place at Simkl', () => {
  assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 0, episode: 1 }, membersOf), null)
  assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 4, episode: 1 }, membersOf), null)
  assert.equal(toSimklAnimeEpisode({ id: ALONE, season: 0, episode: 1 }, membersOf), null)
})

check('an episode or season that is not a whole number from 1 is refused', () => {
  for (const episode of [0, -1, 1.5, Number.NaN, undefined, null]) {
    assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 1, episode }, membersOf), null)
  }
  for (const season of [-1, 1.5, Number.NaN]) {
    assert.equal(toSimklAnimeEpisode({ id: SHOW, season, episode: 1 }, membersOf), null)
  }
})

check('a title with no group maps to itself, whatever season Kitsu labels it', () => {
  assert.deepEqual(toSimklAnimeEpisode({ id: ALONE, season: 1, episode: 7 }, membersOf), {
    id: ALONE,
    episode: 7
  })
  // One Kitsu entry is one Simkl entry. A season of 2 on its episode list
  // is Kitsu's label for that entry, not a second entry.
  assert.deepEqual(toSimklAnimeEpisode({ id: ALONE, season: 2, episode: 7 }, membersOf), {
    id: ALONE,
    episode: 7
  })
})

check("a later season written under its own id is that id's own entry", () => {
  for (const season of [1, 2]) {
    assert.deepEqual(toSimklAnimeEpisode({ id: SEASON_2, season, episode: 4 }, membersOf), {
      id: SEASON_2,
      episode: 4
    })
  }
})

check('before the catalog is grouped only a first season is placed', () => {
  assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season: 1, episode: 5 }, undefined), {
    id: SHOW,
    episode: 5
  })
  // Nothing can tell a merged show from an unmerged one yet, and sending a
  // later season to the id it was asked under is the misfiling itself.
  assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 2, episode: 5 }, undefined), null)
  assert.equal(toSimklAnimeEpisode({ id: ALONE, season: 2, episode: 5 }, undefined), null)
})

// ---------------------------------------------------------------------------
console.log('\nfromSimklAnimeEpisode')

check("an entry's episode lands under the show, at the season the entry is", () => {
  assert.deepEqual(fromSimklAnimeEpisode({ id: SEASON_2, episode: 5 }, targetOf), {
    id: SHOW,
    season: 2,
    episode: 5
  })
  assert.deepEqual(fromSimklAnimeEpisode({ id: SHOW, episode: 5 }, targetOf), {
    id: SHOW,
    season: 1,
    episode: 5
  })
  assert.deepEqual(fromSimklAnimeEpisode({ id: ALONE, episode: 3 }, targetOf), {
    id: ALONE,
    season: 1,
    episode: 3
  })
})

check('an episode number that is not a whole number from 1 is refused', () => {
  for (const episode of [0, 2.5, Number.NaN]) {
    assert.equal(fromSimklAnimeEpisode({ id: SHOW, episode }, targetOf), null)
  }
})

// ---------------------------------------------------------------------------
console.log('\nround trip')

const EPISODES = [1, 2, 12, 366]

check('local -> Simkl -> local is the identity for every season of a merged show', () => {
  for (const season of [1, 2, 3]) {
    for (const episode of EPISODES) {
      const local: LocalAnimeEpisode = { id: SHOW, season, episode }
      const remote = toSimklAnimeEpisode(local, membersOf)
      assert.ok(remote, `season ${season} has an entry`)
      assert.deepEqual(fromSimklAnimeEpisode(remote, targetOf), local)
    }
  }
  for (const episode of EPISODES) {
    const local: LocalAnimeEpisode = { id: ALONE, season: 1, episode }
    const remote = toSimklAnimeEpisode(local, membersOf)
    assert.ok(remote)
    assert.deepEqual(fromSimklAnimeEpisode(remote, targetOf), local)
  }
})

check('Simkl -> local -> Simkl is the identity for every entry', () => {
  for (const id of [SHOW, SEASON_2, SEASON_3, ALONE]) {
    for (const episode of EPISODES) {
      const local = fromSimklAnimeEpisode({ id, episode }, targetOf)
      assert.ok(local)
      assert.deepEqual(toSimklAnimeEpisode(local, membersOf), { id, episode })
    }
  }
})

check('the two rows that do not come back as they went out', () => {
  // A later season written under its OWN id reaches the right entry, and
  // comes back under the show it belongs to.
  const sibling = toSimklAnimeEpisode({ id: SEASON_2, season: 1, episode: 4 }, membersOf)
  assert.ok(sibling)
  assert.deepEqual(fromSimklAnimeEpisode(sibling, targetOf), { id: SHOW, season: 2, episode: 4 })
  // An unmerged title Kitsu labels season 2 comes back at season 1: the
  // entry is all Simkl remembers.
  const labelled = toSimklAnimeEpisode({ id: ALONE, season: 2, episode: 4 }, membersOf)
  assert.ok(labelled)
  assert.deepEqual(fromSimklAnimeEpisode(labelled, targetOf), { id: ALONE, season: 1, episode: 4 })
})

// ---------------------------------------------------------------------------
console.log('\na later season named by its own id')

check('it belongs to its show; a show and an unmerged title belong to nothing', () => {
  assert.deepEqual(animeSeasonOf(SEASON_2, targetOf), { id: SHOW, season: 2 })
  assert.deepEqual(animeSeasonOf(SEASON_3, targetOf), { id: SHOW, season: 3 })
  assert.equal(animeSeasonOf(SHOW, targetOf), null)
  assert.equal(animeSeasonOf(ALONE, targetOf), null)
})

check('an episode written under it is kept under the show, at its season there', () => {
  // Whatever season it arrived with: that is Kitsu's label for the one
  // entry, and the episode number is already the entry's own.
  for (const season of [1, 2, undefined]) {
    assert.deepEqual(animeHistoryCoordinates({ id: SEASON_2, season, episode: 4 }, targetOf), {
      id: SHOW,
      season: 2,
      episode: 4
    })
  }
  assert.deepEqual(animeHistoryCoordinates({ id: SEASON_3, season: 1, episode: 1 }, targetOf), {
    id: SHOW,
    season: 3,
    episode: 1
  })
})

check('which is where the same episode comes back from Simkl', () => {
  const kept = animeHistoryCoordinates({ id: SEASON_2, season: 1, episode: 4 }, targetOf)
  const sent = toSimklAnimeEpisode(kept, membersOf)
  assert.deepEqual(sent, { id: SEASON_2, episode: 4 }, "still the season's own entry")
  assert.ok(sent)
  assert.deepEqual(fromSimklAnimeEpisode(sent, targetOf), kept)
})

check('a show, an unmerged title and a row with no episode stay as they are', () => {
  for (const local of [
    { id: SHOW, season: 2, episode: 4 },
    { id: SHOW, season: 0, episode: 1 },
    { id: ALONE, season: 2, episode: 4 },
    { id: SEASON_2, season: null, episode: null },
    { id: SEASON_2 }
  ]) {
    assert.deepEqual(animeHistoryCoordinates(local, targetOf), local)
  }
})

// ---------------------------------------------------------------------------
console.log('\na place in the group is not always the season on the page')

// A show whose first member has a TheTVDB mapping is numbered by TMDB on its
// page: season N is TMDB's season N, whichever member sits at N. Each group
// below is a shape found in a real library.
const TMDB_SHOW = 'kitsu:11469'
const TVDB: Record<string, { seriesId: string; season: number } | 'none'> = {
  // My Hero Academia: seasons 1-3 map to their own TheTVDB seasons, then an
  // OVA sits at place 4 and the real fourth season, unmapped, at place 5.
  [TMDB_SHOW]: { seriesId: '305074', season: 1 },
  'kitsu:12268': { seriesId: '305074', season: 2 },
  'kitsu:13881': { seriesId: '305074', season: 3 },
  'kitsu:12511': 'none',
  'kitsu:41971': 'none',
  // A show built from its members; its third member was never looked up.
  [SHOW]: 'none',
  [SEASON_2]: 'none',
  // Two cours Kitsu maps to one TheTVDB season, the later cour listed first.
  'kitsu:7158': { seriesId: '262954', season: 1 },
  'kitsu:8743': { seriesId: '262954', season: 2 },
  'kitsu:8063': { seriesId: '262954', season: 2 },
  // Both halves of a first season, mapped to it alike.
  'kitsu:6028': { seriesId: '79151', season: 1 },
  'kitsu:6508': { seriesId: '79151', season: 1 },
  // A recap in front of the show it recaps.
  'kitsu:8574': { seriesId: '262090', season: 0 },
  'kitsu:7000': { seriesId: '262090', season: 1 },
  'kitsu:7863': { seriesId: '262090', season: 2 },
  // A show fronted by a later season: its first was never crawled.
  'kitsu:8203': { seriesId: '114801', season: 5 },
  'kitsu:9999': { seriesId: '114801', season: 6 },
  // A gap in the numbering: the third stage is a film, so the fourth sits
  // at place 3.
  'kitsu:185': { seriesId: '79172', season: 1 },
  'kitsu:186': { seriesId: '79172', season: 2 },
  'kitsu:9': { seriesId: '79172', season: 4 },
  // Two series merged into one show: Naruto behind Naruto: Shippuden.
  'kitsu:1555': { seriesId: '79824', season: 1 },
  'kitsu:11': { seriesId: '78857', season: 1 },
  // A well-mapped show with one member nobody has looked up.
  'kitsu:501': { seriesId: '555', season: 1 },
  'kitsu:503': { seriesId: '555', season: 3 }
}
const tvdbOf: AnimeTvdbSeason = (id) => TVDB[id] ?? null

const MHA = [TMDB_SHOW, 'kitsu:12268', 'kitsu:13881', 'kitsu:12511', 'kitsu:41971']
const BUILT = [SHOW, SEASON_2, SEASON_3]
const TWO_COURS = ['kitsu:7158', 'kitsu:8743', 'kitsu:8063']
const SPLIT_FIRST = ['kitsu:6028', 'kitsu:6508']
const RECAP_FIRST = ['kitsu:8574', 'kitsu:7000', 'kitsu:7863']
const LATER_FIRST = ['kitsu:8203', 'kitsu:9999']
const GAP = ['kitsu:185', 'kitsu:186', 'kitsu:9']
const TWO_SERIES = ['kitsu:1555', 'kitsu:11']
const UNASKED = ['kitsu:501', 'kitsu:502', 'kitsu:503']
const NEVER_ASKED = ['kitsu:1', 'kitsu:2']
const GROUPS = [
  MHA,
  BUILT,
  TWO_COURS,
  SPLIT_FIRST,
  RECAP_FIRST,
  LATER_FIRST,
  GAP,
  TWO_SERIES,
  UNASKED,
  NEVER_ASKED
]

check('a show built from its members: every member is its season', () => {
  // Even a member nobody has looked up: the page is the members, in order.
  assert.deepEqual(animeSeasonMembers(BUILT, tvdbOf), BUILT)
})

check('a show numbered by TMDB: only a member whose own season is its place', () => {
  // An OVA at place 4, and the fourth season at place 5: neither is the
  // page's season 4 or 5 as far as anything can show.
  assert.deepEqual(animeSeasonMembers(MHA, tvdbOf), [
    TMDB_SHOW,
    'kitsu:12268',
    'kitsu:13881',
    null,
    null
  ])
  // A member of another series is no season of this show's page.
  assert.deepEqual(animeSeasonMembers(TWO_SERIES, tvdbOf), ['kitsu:1555', null])
})

check('two members mapped to one season: neither can be shown to be it', () => {
  // The member at place 2 is the LATER cour here. Sent there by its place,
  // episode 1 of the season would be marked on episode 1 of the wrong half.
  assert.deepEqual(animeSeasonMembers(TWO_COURS, tvdbOf), ['kitsu:7158', null, null])
  // And that holds for a first season too.
  assert.deepEqual(animeSeasonMembers(SPLIT_FIRST, tvdbOf), [null, null])
})

check('a show fronted by something other than its first season', () => {
  // Season 1 of the page is TMDB's first season. The recap that fronts the
  // group is not it, and the real first season sits at place 2.
  assert.deepEqual(animeSeasonMembers(RECAP_FIRST, tvdbOf), [null, null, null])
  assert.deepEqual(animeSeasonMembers(LATER_FIRST, tvdbOf), [null, null])
})

check('a member at another place than its season is left out', () => {
  // Probably season 4. But where TMDB has no season 4 the page fills it
  // from the member at place 4, and nothing here can tell which it did.
  assert.deepEqual(animeSeasonMembers(GAP, tvdbOf), ['kitsu:185', 'kitsu:186', null])
})

check('a mapping nobody has looked up proves nothing', () => {
  assert.deepEqual(animeSeasonMembers(NEVER_ASKED, tvdbOf), [null, null])
  // One member never asked about could be any season of the series, so
  // none of the others can be shown to be the only one at theirs.
  assert.deepEqual(animeSeasonMembers(UNASKED, tvdbOf), [null, null, null])
  assert.deepEqual(animeSeasonMembers([], tvdbOf), [])
})

check('season -> member -> season, and member -> season -> member, round trip', () => {
  for (const group of GROUPS) {
    const seasons = animeSeasonMembers(group, tvdbOf)
    assert.equal(seasons.length, group.length, 'one answer per season of the page')
    seasons.forEach((member, index) => {
      if (member) assert.equal(animeSeasonOfMember(group, member, tvdbOf), index + 1)
    })
    for (const member of group) {
      const season = animeSeasonOfMember(group, member, tvdbOf)
      if (season === null) assert.equal(seasons.includes(member), false)
      else assert.equal(seasons[season - 1], member)
    }
    // No member is two seasons.
    const placed = seasons.filter((member) => member !== null)
    assert.equal(new Set(placed).size, placed.length)
  }
  assert.equal(animeSeasonOfMember(MHA, 'kitsu:404', tvdbOf), null, 'not a member at all')
})

check('the mappings alone say less than the rule, and are not the rule', () => {
  // What the regroup asks of a grouping that is gone (animeTvdbSeasonIs):
  // the member's own TheTVDB season, with no place and no other member in
  // it. Psycho-Pass is TheTVDB's season 1 and sits second behind a recap;
  // both cours are TheTVDB's season 2.
  assert.equal(animeTvdbSeasonIs('kitsu:8574', 'kitsu:7000', 1, tvdbOf), true)
  assert.equal(animeSeasonOfMember(RECAP_FIRST, 'kitsu:7000', tvdbOf), null)
  assert.equal(animeTvdbSeasonIs('kitsu:7158', 'kitsu:8743', 2, tvdbOf), true)
  assert.equal(animeTvdbSeasonIs('kitsu:7158', 'kitsu:8063', 2, tvdbOf), true)
  assert.deepEqual(animeSeasonMembers(TWO_COURS, tvdbOf).slice(1), [null, null])
  // No mapping, another series, a show nobody has looked up: no.
  assert.equal(animeTvdbSeasonIs(TMDB_SHOW, 'kitsu:41971', 5, tvdbOf), false)
  assert.equal(animeTvdbSeasonIs('kitsu:1555', 'kitsu:11', 1, tvdbOf), false)
  assert.equal(animeTvdbSeasonIs('kitsu:1', 'kitsu:2', 2, tvdbOf), false)
  // A show built from its members has no mappings to disagree with.
  assert.equal(animeTvdbSeasonIs(SHOW, SEASON_3, 3, tvdbOf), true)
})

// What animeSeasons.ts builds from the grouped catalog: the group an id
// belongs to, and the seasons of a show an id fronts.
const groupOf: AnimeGroupOf = (id) => GROUPS.find((group) => group.includes(id))
const seasonsOf: AnimeSeasonMembers = (id) => {
  const group = GROUPS.find((members) => members[0] === id)
  return group && animeSeasonMembers(group, tvdbOf)
}
const placeOf = (id: string): { id: string; season: number } | null =>
  animeEntryTarget(id, groupOf, tvdbOf)

check("where a service's entry is kept", () => {
  // A season of its show's page: under the show, at that season.
  assert.deepEqual(placeOf(TMDB_SHOW), { id: TMDB_SHOW, season: 1 })
  assert.deepEqual(placeOf('kitsu:13881'), { id: TMDB_SHOW, season: 3 })
  assert.deepEqual(placeOf(SEASON_3), { id: SHOW, season: 3 })
  // A later member that cannot be shown to be one: a title of its own,
  // never the season that sits at its place.
  assert.deepEqual(placeOf('kitsu:41971'), { id: 'kitsu:41971', season: 1 })
  assert.deepEqual(placeOf('kitsu:12511'), { id: 'kitsu:12511', season: 1 })
  assert.deepEqual(placeOf('kitsu:11'), { id: 'kitsu:11', season: 1 })
  assert.deepEqual(placeOf('kitsu:8743'), { id: 'kitsu:8743', season: 1 })
  assert.deepEqual(placeOf('kitsu:7000'), { id: 'kitsu:7000', season: 1 })
  // The show's own id, when it is not its first season: no place at all.
  assert.equal(placeOf('kitsu:8574'), null)
  assert.equal(placeOf('kitsu:6028'), null)
  assert.equal(placeOf('kitsu:8203'), null)
  // A title that was never merged is itself.
  assert.deepEqual(placeOf(ALONE), { id: ALONE, season: 1 })
})

const mha = { id: TMDB_SHOW, type: 'anime' as const, title: 'My Hero Academia', year: '2016' }

check(
  'the later seasons of the whole catalog are the members that are a season of their show',
  () => {
    // What the library's filters are handed (animeSeasons.ts's laterSeasons):
    // the same answer for every id that laterSeasonOf gives one at a time.
    const grouped = animeGroupIndexesOf([
      { id: SHOW, groupedIds: [SEASON_2, SEASON_3] },
      { id: TMDB_SHOW, groupedIds: ['kitsu:12268', 'kitsu:13881', 'kitsu:12511', 'kitsu:41971'] },
      { id: ALONE }
    ])
    const laterSeasons = laterSeasonsOf(
      grouped.positions,
      (showId, member, season) =>
        animeSeasonMembers([showId, ...(grouped.siblings.get(showId) ?? [])], tvdbOf)[
          season - 1
        ] === member
    )
    assert.deepEqual(
      [...laterSeasons],
      [
        [SEASON_2, { id: SHOW, season: 2 }],
        [SEASON_3, { id: SHOW, season: 3 }],
        ['kitsu:12268', { id: TMDB_SHOW, season: 2 }],
        ['kitsu:13881', { id: TMDB_SHOW, season: 3 }]
      ],
      'the OVA at place 4 and the unmapped season at place 5 keep their own rows'
    )
    // A show is not its own later season, and neither is a title in no group.
    for (const id of [SHOW, TMDB_SHOW, ALONE]) assert.equal(laterSeasons.has(id), false, id)
  }
)

check('a season whose member cannot be shown to be it is not sent to Simkl', () => {
  assert.deepEqual(historyPayload(mha, { season: 3, episode: 5 }, seasonsOf), {
    anime: [{ ids: { kitsu: 13881 }, episodes: [{ number: 5 }] }]
  })
  // Season 4 on the page is TMDB's fourth season; the member at place 4 is
  // an OVA. Sent there, episode 5 would be marked on the wrong entry.
  assert.deepEqual(historyPayload(mha, { season: 4, episode: 5 }, seasonsOf), {})
  assert.deepEqual(historyPayload(mha, { season: 5, episode: 5 }, seasonsOf), {})
  assert.equal(scrobblePayload(mha, { season: 4, episode: 5 }, 50, seasonsOf), null)
  assert.deepEqual(
    titleHistoryPayload(
      mha,
      [
        { season: 1, episodes: [1] },
        { season: 2, episodes: [1] },
        { season: 4, episodes: [1, 2] }
      ],
      seasonsOf
    ),
    {
      anime: [
        { title: 'My Hero Academia', year: 2016, ids: { kitsu: 11469 }, episodes: [{ number: 1 }] },
        { ids: { kitsu: 12268 }, episodes: [{ number: 1 }] }
      ]
    }
  )
})

check('nor is a first season the show itself cannot be shown to be', () => {
  // Season 1 of this page is the show the recap recaps. Sent to the id the
  // page is under, it would be marked on the recap's entry.
  const recap = { id: 'kitsu:8574', type: 'anime' as const, title: 'Psycho-Pass', year: '2012' }
  assert.deepEqual(historyPayload(recap, { season: 1, episode: 5 }, seasonsOf), {})
  assert.deepEqual(historyPayload(recap, { season: 2, episode: 5 }, seasonsOf), {})
  assert.equal(scrobblePayload(recap, { season: 1, episode: 5 }, 50, seasonsOf), null)
  // While the catalog is not grouped nothing can tell, and a first season
  // goes to the id it was asked under, as it always has.
  assert.deepEqual(historyPayload(recap, { season: 1, episode: 5 }, undefined), {
    anime: [{ title: 'Psycho-Pass', year: 2012, ids: { kitsu: 8574 }, episodes: [{ number: 5 }] }]
  })
})

check('a later member opened by its own id is still its own entry', () => {
  // It fronts no group, so whatever season its own page labels it, the
  // episode goes to the entry its id names.
  const fourth = { id: 'kitsu:41971', type: 'anime' as const, title: 'MHA 4', year: '2019' }
  for (const season of [1, 4]) {
    assert.deepEqual(historyPayload(fourth, { season, episode: 5 }, seasonsOf), {
      anime: [{ title: 'MHA 4', year: 2019, ids: { kitsu: 41971 }, episodes: [{ number: 5 }] }]
    })
  }
})

check('local -> Simkl -> local is the identity for every season that is sent', () => {
  for (const group of GROUPS) {
    group.forEach((_, index) => {
      for (const episode of EPISODES) {
        const local: LocalAnimeEpisode = { id: group[0], season: index + 1, episode }
        const remote = toSimklAnimeEpisode(local, seasonsOf)
        if (remote) assert.deepEqual(fromSimklAnimeEpisode(remote, placeOf), local)
      }
    })
  }
})

check('Simkl -> local -> Simkl is the identity for every entry that is kept', () => {
  for (const id of GROUPS.flat()) {
    for (const episode of EPISODES) {
      const local = fromSimklAnimeEpisode({ id, episode }, placeOf)
      if (local) assert.deepEqual(toSimklAnimeEpisode(local, seasonsOf), { id, episode })
      else assert.equal(placeOf(id), null)
    }
  }
})

check('a film is not a season: out of the show, each season reaches its own entry', () => {
  // TheTVDB files a film at season 0 of its series, so the grouping sorted
  // it first and it fronted the show. Every place was then one off its
  // season, and no member could be shown to be any season of the page: not
  // the film at season 1 either, which is the show's first season there.
  // groupAnimeCatalog now keeps the film out of the show (it is not a TV
  // entry) and names it in groupedExtras instead.
  const tvdb: Record<string, { seriesId: string; season: number }> = {
    'kitsu:7001': { seriesId: '371028', season: 0 },
    'kitsu:7002': { seriesId: '371028', season: 1 },
    'kitsu:7003': { seriesId: '371028', season: 2 }
  }
  const tvdbFor: AnimeTvdbSeason = (id) => tvdb[id] ?? null
  const seasonsWith = (front: string, later: string[]): AnimeSeasonMembers => {
    return (id) => (id === front ? animeSeasonMembers([front, ...later], tvdbFor) : undefined)
  }
  const before = seasonsWith('kitsu:7001', ['kitsu:7002', 'kitsu:7003'])
  const filmFront = { id: 'kitsu:7001', type: 'anime' as const, title: 'Show', year: '2019' }
  assert.deepEqual(historyPayload(filmFront, { season: 1, episode: 5 }, before), {})
  assert.deepEqual(historyPayload(filmFront, { season: 2, episode: 5 }, before), {})

  const after = seasonsWith('kitsu:7002', ['kitsu:7003'])
  const showNow = { id: 'kitsu:7002', type: 'anime' as const, title: 'Show', year: '2019' }
  assert.deepEqual(historyPayload(showNow, { season: 1, episode: 5 }, after), {
    anime: [{ title: 'Show', year: 2019, ids: { kitsu: 7002 }, episodes: [{ number: 5 }] }]
  })
  assert.deepEqual(historyPayload(showNow, { season: 2, episode: 5 }, after), {
    anime: [{ ids: { kitsu: 7003 }, episodes: [{ number: 5 }] }]
  })
  // The film is a title of its own: its one episode is its own entry's.
  const film = { id: 'kitsu:7001', type: 'anime' as const, title: 'Show: The Movie', year: '2020' }
  assert.deepEqual(historyPayload(film, { season: 1, episode: 1 }, after), {
    anime: [
      { title: 'Show: The Movie', year: 2020, ids: { kitsu: 7001 }, episodes: [{ number: 1 }] }
    ]
  })
  // And a later season's own id is the show's at its season, the film's is
  // nobody's.
  const grouped = animeGroupIndexesOf([
    { id: 'kitsu:7002', groupedIds: ['kitsu:7003'] },
    { id: 'kitsu:7001' }
  ])
  const later = laterSeasonsOf(
    grouped.positions,
    (showId, member, season) =>
      animeSeasonMembers([showId, ...(grouped.siblings.get(showId) ?? [])], tvdbFor)[season - 1] ===
      member
  )
  assert.deepEqual([...later], [['kitsu:7003', { id: 'kitsu:7002', season: 2 }]])
})

// ---------------------------------------------------------------------------
console.log('\nrequest bodies')

check("marking season 2 episode 5 names the second season's entry, flat, by id alone", () => {
  // No title or year: they are the show's, which at Simkl are the first
  // season's, and Simkl falls back to them when it cannot place an id.
  assert.deepEqual(historyPayload(show, { season: 2, episode: 5 }, membersOf), {
    anime: [{ ids: { kitsu: 200 }, episodes: [{ number: 5 }] }]
  })
})

check('a first season keeps its title and year, and still sends no season', () => {
  assert.deepEqual(historyPayload(show, { season: 1, episode: 5 }, membersOf), {
    anime: [{ title: 'Bleach', year: 2004, ids: { kitsu: 100 }, episodes: [{ number: 5 }] }]
  })
  assert.deepEqual(historyPayload(alone, { episode: 9 }, membersOf), {
    anime: [{ title: 'Frieren', year: 2023, ids: { kitsu: 900 }, episodes: [{ number: 9 }] }]
  })
})

check("marking a season sends that season's entry its episodes", () => {
  assert.deepEqual(seasonHistoryPayload(show, 3, [2, 1, 3], membersOf), {
    anime: [{ ids: { kitsu: 300 }, episodes: [{ number: 1 }, { number: 2 }, { number: 3 }] }]
  })
})

const WHOLE_TITLE = [
  { season: 0, episodes: [1, 2] },
  { season: 1, episodes: [1, 2, 2] },
  { season: 2, episodes: [1] },
  { season: 3, episodes: [] },
  { season: 4, episodes: [1] }
]

check('a whole title is one entry per season it touched', () => {
  assert.deepEqual(titleHistoryPayload(show, WHOLE_TITLE, membersOf), {
    anime: [
      {
        title: 'Bleach',
        year: 2004,
        ids: { kitsu: 100 },
        episodes: [{ number: 1 }, { number: 2 }]
      },
      { ids: { kitsu: 200 }, episodes: [{ number: 1 }] }
    ]
  })
})

check('specials, an empty list and an unplaceable season send nothing at all', () => {
  const bodies: SimklHistoryPayload[] = [
    historyPayload(show, { season: 0, episode: 1 }, membersOf),
    historyPayload(show, { season: 4, episode: 1 }, membersOf),
    historyPayload(show, {}, membersOf),
    seasonHistoryPayload(show, 0, [1, 2], membersOf),
    seasonHistoryPayload(show, 2, [], membersOf),
    titleHistoryPayload(show, [{ season: 0, episodes: [1] }], membersOf),
    titleHistoryPayload(show, [], membersOf)
  ]
  for (const body of bodies) {
    assert.deepEqual(body, {})
    assert.equal(hasSimklContent(body), false)
  }
})

check('no anime entry ever goes out without episodes, or with a season', () => {
  // Sent to /sync/history/remove, an anime reference naming no episodes
  // removes that entry's whole history.
  const bodies: SimklHistoryPayload[] = [
    historyPayload(show, { season: 2, episode: 5 }, membersOf),
    historyPayload(show, { season: 2 }, membersOf),
    historyPayload(alone, {}, membersOf),
    seasonHistoryPayload(show, 1, [], membersOf),
    seasonHistoryPayload(show, 2, [0, 3], membersOf),
    titleHistoryPayload(show, WHOLE_TITLE, membersOf),
    titleHistoryPayload(show, WHOLE_TITLE),
    batchHistoryPayload(
      [{ item: show, playback: { season: 3, episode: 2 } }, { item: alone }],
      membersOf
    )
  ]
  for (const body of bodies) {
    for (const entry of body.anime ?? []) {
      assert.ok(entry.episodes.length > 0, JSON.stringify(body))
      assert.equal('seasons' in entry, false)
    }
    assert.equal(body.shows, undefined, 'anime is never a shows entry')
  }
  assert.deepEqual(bodies[4], { anime: [{ ids: { kitsu: 200 }, episodes: [{ number: 3 }] }] })
  assert.deepEqual(bodies[7], { anime: [{ ids: { kitsu: 300 }, episodes: [{ number: 2 }] }] })
})

check('before the catalog is grouped a later season is not sent', () => {
  assert.deepEqual(historyPayload(show, { season: 2, episode: 5 }), {})
  assert.deepEqual(seasonHistoryPayload(show, 2, [1, 2]), {})
  assert.equal(scrobblePayload(show, { season: 2, episode: 5 }, 50), null)
  // A first season still is: it is the id's own entry either way.
  assert.deepEqual(titleHistoryPayload(show, WHOLE_TITLE), {
    anime: [
      { title: 'Bleach', year: 2004, ids: { kitsu: 100 }, episodes: [{ number: 1 }, { number: 2 }] }
    ]
  })
})

check('a scrobble names the entry and the flat episode, with no season', () => {
  assert.deepEqual(scrobblePayload(show, { season: 2, episode: 5 }, 42, membersOf), {
    progress: 42,
    anime: { ids: { kitsu: 200 } },
    episode: { number: 5 }
  })
  assert.deepEqual(scrobblePayload(show, { season: 1, episode: 5 }, 42, membersOf), {
    progress: 42,
    anime: { title: 'Bleach', year: 2004, ids: { kitsu: 100 } },
    episode: { number: 5 }
  })
  // A one-off with no episode coordinate is its entry's only episode.
  assert.deepEqual(scrobblePayload(alone, {}, 10, membersOf)?.episode, { number: 1 })
  assert.equal(scrobblePayload(show, { season: 0, episode: 1 }, 42, membersOf), null)
  assert.equal(scrobblePayload(show, { season: 4, episode: 1 }, 42, membersOf), null)
})

check('a series and a film are built exactly as before', () => {
  const series = { id: 'tt0903747', type: 'series' as const, title: 'Breaking Bad', year: '2008' }
  assert.deepEqual(historyPayload(series, { season: 2, episode: 5 }, membersOf), {
    shows: [
      {
        title: 'Breaking Bad',
        year: 2008,
        ids: { imdb: 'tt0903747' },
        seasons: [{ number: 2, episodes: [{ number: 5 }] }]
      }
    ]
  })
  assert.deepEqual(scrobblePayload(series, { season: 2, episode: 5 }, 42, membersOf), {
    progress: 42,
    show: { title: 'Breaking Bad', year: 2008, ids: { imdb: 'tt0903747' } },
    episode: { season: 2, number: 5 }
  })
  const film = { id: 'tt0245429', type: 'movie' as const, title: 'Spirited Away', year: '2001' }
  assert.deepEqual(historyPayload(film, {}, membersOf), {
    movies: [{ title: 'Spirited Away', year: 2001, ids: { imdb: 'tt0245429' } }]
  })
})

// ---------------------------------------------------------------------------
console.log('\nthe catch-up reads back what a push sent')

/**
 * Simkl's anime library as its guide describes it: an entry per anime id,
 * its episodes numbered flat. `add` and `remove` take the bodies this app
 * sends; `library` answers as /sync/all-items/anime does.
 */
function simklAccount(): {
  add(body: SimklHistoryPayload): void
  remove(body: SimklHistoryPayload): void
  held(): Record<string, number[]>
  library(flat?: boolean): unknown
} {
  const entries = new Map<number, Set<number>>()
  const each = (
    body: SimklHistoryPayload,
    fn: (episodes: Set<number>, number: number) => void
  ): void => {
    for (const entry of body.anime ?? []) {
      const kitsu = entry.ids.kitsu
      assert.ok(kitsu, 'an anime entry is named by its Kitsu id')
      const episodes = entries.get(kitsu) ?? new Set<number>()
      entries.set(kitsu, episodes)
      for (const episode of entry.episodes) {
        assert.ok(episode.number, 'and every episode by its number')
        fn(episodes, episode.number)
      }
    }
  }
  return {
    add: (body) => each(body, (episodes, number) => episodes.add(number)),
    remove: (body) => each(body, (episodes, number) => episodes.delete(number)),
    held: () =>
      Object.fromEntries(
        [...entries]
          .filter(([, episodes]) => episodes.size)
          .map(([kitsu, episodes]) => [`kitsu:${kitsu}`, [...episodes].sort((a, b) => a - b)])
      ),
    library: (flat = false) => ({
      anime: [...entries]
        .filter(([, episodes]) => episodes.size)
        .map(([kitsu, episodes]) => {
          const list = [...episodes].map((number) => ({
            number,
            watched_at: '2026-09-19T21:00:00Z'
          }))
          return {
            show: { title: `Entry ${kitsu}`, ids: { simkl: 5000 + kitsu, kitsu } },
            anime_type: 'tv',
            status: 'watching',
            last_watched_at: '2026-09-19T21:00:00Z',
            watched_episodes_count: list.length,
            ...(flat ? { episodes: list } : { seasons: [{ number: 1, episodes: list }] })
          }
        })
    })
  }
}

const NOW = new Date('2026-09-20T12:00:00.000Z')

/** The catch-up's own steps (simklCatchUp.ts): parse the library, place
 *  each entry by its Kitsu id, plan against what the device holds. */
function caughtUp(
  library: unknown,
  watchedKeys: Iterable<string> = [],
  place: (id: string) => { id: string; season: number } | null = targetOf
): string[] {
  const { titles, dropped } = parseSimklLibrary({ anime: library })
  assert.equal(dropped, 0)
  const resolved: ResolvedTitle[] = titles.flatMap((title) => {
    const target = place(`kitsu:${title.kitsu}`)
    // An entry with no place is skipped and counted by the pass.
    if (!target) return []
    return [{ title, id: target.id, type: 'anime' as const, animeSeason: target.season }]
  })
  const local: CatchUpLocal = {
    watchedKeys: new Set(watchedKeys),
    trackedIds: new Set(),
    awaitingRemoval: new Set()
  }
  const plan = planCatchUp(resolved, local, {}, NOW)
  assert.equal(plan.rejected, 0)
  return plan.plays.map((play) => `${play.id}:${play.season}:${play.episode}`).sort()
}

// What one device holds: three seasons of the merged show, and a special.
const WATCHED: LocalAnimeEpisode[] = [
  { id: SHOW, season: 0, episode: 1 },
  { id: SHOW, season: 1, episode: 1 },
  { id: SHOW, season: 1, episode: 2 },
  { id: SHOW, season: 1, episode: 3 },
  { id: SHOW, season: 2, episode: 1 },
  { id: SHOW, season: 2, episode: 2 },
  { id: SHOW, season: 3, episode: 5 }
]
const keyOf = (row: LocalAnimeEpisode): string => `${row.id}:${row.season}:${row.episode}`
const REGULAR = WATCHED.filter((row) => row.season > 0)
  .map(keyOf)
  .sort()

function pushed(): ReturnType<typeof simklAccount> {
  const account = simklAccount()
  account.add(titleHistoryPayload(show, bySeason(WATCHED), membersOf))
  return account
}

check('each season reaches its own entry', () => {
  assert.deepEqual(pushed().held(), {
    [SHOW]: [1, 2, 3],
    [SEASON_2]: [1, 2],
    [SEASON_3]: [5]
  })
})

check('a device with nothing takes back exactly the rows that were pushed', () => {
  assert.deepEqual(caughtUp(pushed().library()), REGULAR)
  assert.deepEqual(caughtUp(pushed().library(true)), REGULAR, 'flat episodes, no season block')
})

check('and files each where fromSimklAnimeEpisode says', () => {
  const expected = Object.entries(pushed().held())
    .flatMap(([id, episodes]) =>
      episodes.map((episode) => fromSimklAnimeEpisode({ id, episode }, targetOf))
    )
    .map((row) => keyOf(row as LocalAnimeEpisode))
    .sort()
  assert.deepEqual(caughtUp(pushed().library()), expected)
})

check('the device that pushed them takes nothing back', () => {
  assert.deepEqual(caughtUp(pushed().library(), WATCHED.map(keyOf)), [])
})

check('an unmark removes the one episode, from the one entry', () => {
  const account = pushed()
  account.remove(historyPayload(show, { season: 2, episode: 1 }, membersOf))
  assert.deepEqual(account.held(), { [SHOW]: [1, 2, 3], [SEASON_2]: [2], [SEASON_3]: [5] })
  account.remove(titleHistoryPayload(show, bySeason(WATCHED), membersOf))
  assert.deepEqual(account.held(), {})
})

// ---------------------------------------------------------------------------
console.log('\na show numbered by TMDB, pushed and read back')

check('only the seasons a member can be shown to be reach Simkl', () => {
  const account = simklAccount()
  account.add(
    titleHistoryPayload(
      mha,
      [
        { season: 1, episodes: [1, 2] },
        { season: 3, episodes: [1] },
        { season: 4, episodes: [1, 2] },
        { season: 5, episodes: [7] }
      ],
      seasonsOf
    )
  )
  assert.deepEqual(account.held(), { [TMDB_SHOW]: [1, 2], 'kitsu:13881': [1] })
  assert.deepEqual(caughtUp(account.library(), [], placeOf), [
    `${TMDB_SHOW}:1:1`,
    `${TMDB_SHOW}:1:2`,
    `${TMDB_SHOW}:3:1`
  ])
})

check('an entry that is no season of the page is kept as itself, never at its place', () => {
  // Watched somewhere else: the third season, the OVA that sits at place 4
  // and the fourth season that sits at place 5.
  const account = simklAccount()
  account.add({
    anime: [
      { ids: { kitsu: 13881 }, episodes: [{ number: 1 }] },
      { ids: { kitsu: 12511 }, episodes: [{ number: 1 }] },
      { ids: { kitsu: 41971 }, episodes: [{ number: 1 }, { number: 2 }] }
    ]
  })
  assert.deepEqual(caughtUp(account.library(), [], placeOf), [
    `${TMDB_SHOW}:3:1`,
    'kitsu:12511:1:1',
    'kitsu:41971:1:1',
    'kitsu:41971:1:2'
  ])
  // By place alone, as it was: the OVA lands on the page's fourth season
  // and the fourth season on its fifth.
  assert.deepEqual(
    caughtUp(account.library(), [], (id) => ({ id: TMDB_SHOW, season: MHA.indexOf(id) + 1 })),
    [`${TMDB_SHOW}:3:1`, `${TMDB_SHOW}:4:1`, `${TMDB_SHOW}:5:1`, `${TMDB_SHOW}:5:2`]
  )
})

check('and what was watched under its own id goes back to the same entry', () => {
  const fourth = { id: 'kitsu:41971', type: 'anime' as const, title: 'MHA 4', year: '2019' }
  const account = simklAccount()
  account.add(historyPayload(fourth, { season: 1, episode: 2 }, seasonsOf))
  assert.deepEqual(account.held(), { 'kitsu:41971': [2] })
  assert.deepEqual(caughtUp(account.library(), ['kitsu:41971:1:2'], placeOf), [])
})

check("a show's own entry that is not its first season is not taken", () => {
  // The recap that fronts the group, and the first season behind it.
  const account = simklAccount()
  account.add({
    anime: [
      { ids: { kitsu: 8574 }, episodes: [{ number: 1 }] },
      { ids: { kitsu: 7000 }, episodes: [{ number: 3 }] }
    ]
  })
  assert.deepEqual(caughtUp(account.library(), [], placeOf), ['kitsu:7000:1:3'])
})

// ---------------------------------------------------------------------------
console.log('\npushes made before the mapping')

// What used to be sent for season 2 episode 5: the canonical id with a
// season number. Filed the way it most likely was — under the canonical
// id's own entry, the season ignored.
function misfiled(): ReturnType<typeof simklAccount> {
  const account = simklAccount()
  account.add({ anime: [{ ids: { kitsu: 100 }, episodes: [{ number: 5 }] }] })
  return account
}

check('the device that made one does not take it back as season 1', () => {
  assert.deepEqual(caughtUp(misfiled().library(), [`${SHOW}:2:5`]), [])
})

check('marking it again sends it to the right entry, and leaves the old one', () => {
  const account = misfiled()
  account.add(historyPayload(show, { season: 2, episode: 5 }, membersOf))
  assert.deepEqual(account.held(), { [SHOW]: [5], [SEASON_2]: [5] })
  assert.deepEqual(caughtUp(account.library(), [`${SHOW}:2:5`]), [])
})

check('a device that never held the later season takes the old one as season 1', () => {
  // The limit docs/WATCHLIST-SYNC.md states: nothing here can tell a
  // misfiled push from a first-season viewing made somewhere else.
  assert.deepEqual(caughtUp(misfiled().library()), [`${SHOW}:1:5`])
})

console.log(`\n${pass} passed`)
