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
  animeHistoryCoordinates,
  animeSeasonMatchesPage,
  animeSeasonOf,
  fromSimklAnimeEpisode,
  toSimklAnimeEpisode,
  type AnimeGroupTarget,
  type AnimeSiblings,
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
const siblingsOf: AnimeSiblings = (id) => siblings.get(id)
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
  assert.deepEqual(siblingsOf(SHOW), [SEASON_2, SEASON_3])
})

check('only the canonical id fronts a group', () => {
  assert.equal(siblingsOf(SEASON_2), undefined)
  assert.equal(siblingsOf(ALONE), undefined)
  assert.equal(positions.has(ALONE), false)
})

// ---------------------------------------------------------------------------
console.log('\ntoSimklAnimeEpisode')

check("season 2 episode 5 is episode 5 of the second season's own entry", () => {
  assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season: 2, episode: 5 }, siblingsOf), {
    id: SEASON_2,
    episode: 5
  })
  assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season: 3, episode: 1 }, siblingsOf), {
    id: SEASON_3,
    episode: 1
  })
})

check("season 1, or no season, is the id's own entry", () => {
  for (const season of [1, undefined, null]) {
    assert.deepEqual(toSimklAnimeEpisode({ id: SHOW, season, episode: 5 }, siblingsOf), {
      id: SHOW,
      episode: 5
    })
  }
})

check('a special, and a season the group has no member for, have no place at Simkl', () => {
  assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 0, episode: 1 }, siblingsOf), null)
  assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 4, episode: 1 }, siblingsOf), null)
  assert.equal(toSimklAnimeEpisode({ id: ALONE, season: 0, episode: 1 }, siblingsOf), null)
})

check('an episode or season that is not a whole number from 1 is refused', () => {
  for (const episode of [0, -1, 1.5, Number.NaN, undefined, null]) {
    assert.equal(toSimklAnimeEpisode({ id: SHOW, season: 1, episode }, siblingsOf), null)
  }
  for (const season of [-1, 1.5, Number.NaN]) {
    assert.equal(toSimklAnimeEpisode({ id: SHOW, season, episode: 1 }, siblingsOf), null)
  }
})

check('a title with no group maps to itself, whatever season Kitsu labels it', () => {
  assert.deepEqual(toSimklAnimeEpisode({ id: ALONE, season: 1, episode: 7 }, siblingsOf), {
    id: ALONE,
    episode: 7
  })
  // One Kitsu entry is one Simkl entry. A season of 2 on its episode list
  // is Kitsu's label for that entry, not a second entry.
  assert.deepEqual(toSimklAnimeEpisode({ id: ALONE, season: 2, episode: 7 }, siblingsOf), {
    id: ALONE,
    episode: 7
  })
})

check("a later season written under its own id is that id's own entry", () => {
  for (const season of [1, 2]) {
    assert.deepEqual(toSimklAnimeEpisode({ id: SEASON_2, season, episode: 4 }, siblingsOf), {
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
      const remote = toSimklAnimeEpisode(local, siblingsOf)
      assert.ok(remote, `season ${season} has an entry`)
      assert.deepEqual(fromSimklAnimeEpisode(remote, targetOf), local)
    }
  }
  for (const episode of EPISODES) {
    const local: LocalAnimeEpisode = { id: ALONE, season: 1, episode }
    const remote = toSimklAnimeEpisode(local, siblingsOf)
    assert.ok(remote)
    assert.deepEqual(fromSimklAnimeEpisode(remote, targetOf), local)
  }
})

check('Simkl -> local -> Simkl is the identity for every entry', () => {
  for (const id of [SHOW, SEASON_2, SEASON_3, ALONE]) {
    for (const episode of EPISODES) {
      const local = fromSimklAnimeEpisode({ id, episode }, targetOf)
      assert.ok(local)
      assert.deepEqual(toSimklAnimeEpisode(local, siblingsOf), { id, episode })
    }
  }
})

check('the two rows that do not come back as they went out', () => {
  // A later season written under its OWN id reaches the right entry, and
  // comes back under the show it belongs to.
  const sibling = toSimklAnimeEpisode({ id: SEASON_2, season: 1, episode: 4 }, siblingsOf)
  assert.ok(sibling)
  assert.deepEqual(fromSimklAnimeEpisode(sibling, targetOf), { id: SHOW, season: 2, episode: 4 })
  // An unmerged title Kitsu labels season 2 comes back at season 1: the
  // entry is all Simkl remembers.
  const labelled = toSimklAnimeEpisode({ id: ALONE, season: 2, episode: 4 }, siblingsOf)
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
  const sent = toSimklAnimeEpisode(kept, siblingsOf)
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
// page: season N is TMDB's season N, whichever member sits at N. Modelled on
// My Hero Academia: seasons 1-3 map to their own TheTVDB seasons, then an OVA
// sits at place 4 and the real fourth season, unmapped, at place 5.
const TMDB_SHOW = 'kitsu:11469'
const TVDB: Record<string, { seriesId: string; season: number } | 'none'> = {
  [TMDB_SHOW]: { seriesId: '305074', season: 1 },
  'kitsu:12268': { seriesId: '305074', season: 2 },
  'kitsu:13881': { seriesId: '305074', season: 3 },
  'kitsu:12511': 'none',
  'kitsu:41971': 'none',
  'kitsu:777': { seriesId: '999', season: 6 },
  [SHOW]: 'none',
  [SEASON_2]: 'none'
}
const tvdbOf: AnimeTvdbSeason = (id) => TVDB[id] ?? null

check('a show built from its members: every place is its season', () => {
  assert.equal(animeSeasonMatchesPage(SHOW, SEASON_2, 2, tvdbOf), true)
  // Even a member nobody has looked up: the page is the members, in order.
  assert.equal(animeSeasonMatchesPage(SHOW, SEASON_3, 3, tvdbOf), true)
})

check('a show numbered by TMDB: only a member whose own season is its place', () => {
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:12268', 2, tvdbOf), true)
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:13881', 3, tvdbOf), true)
  // An OVA at place 4, and the fourth season at place 5: neither is the
  // page's season 4 or 5 as far as anything can show.
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:12511', 4, tvdbOf), false)
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:41971', 5, tvdbOf), false)
  // Its season, but at another place; and a member of another series.
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:13881', 4, tvdbOf), false)
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:777', 6, tvdbOf), false)
})

check('a mapping nobody has looked up proves nothing', () => {
  assert.equal(animeSeasonMatchesPage('kitsu:1', 'kitsu:2', 2, tvdbOf), false)
  assert.equal(animeSeasonMatchesPage(TMDB_SHOW, 'kitsu:2', 2, tvdbOf), false)
})

check('the later seasons of the whole catalog are the members whose place is their season', () => {
  // What the library's filters are handed (animeSeasons.ts's laterSeasons):
  // the same answer for every id that laterSeasonOf gives one at a time.
  const grouped = animeGroupIndexesOf([
    { id: SHOW, groupedIds: [SEASON_2, SEASON_3] },
    { id: TMDB_SHOW, groupedIds: ['kitsu:12268', 'kitsu:13881', 'kitsu:12511', 'kitsu:41971'] },
    { id: ALONE }
  ])
  const laterSeasons = laterSeasonsOf(grouped.positions, (showId, member, season) =>
    animeSeasonMatchesPage(showId, member, season, tvdbOf)
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
})

check('a season whose member cannot be shown to be it is not sent to Simkl', () => {
  // What animeSiblingsWhenGrouped hands the builders: the places that do
  // not match the page are blank.
  const members = ['kitsu:12268', 'kitsu:13881', 'kitsu:12511', 'kitsu:41971']
  const provable: AnimeSiblings = (id) =>
    id === TMDB_SHOW
      ? members.map((member, index) =>
          animeSeasonMatchesPage(TMDB_SHOW, member, index + 2, tvdbOf) ? member : null
        )
      : undefined
  const mha = { id: TMDB_SHOW, type: 'anime' as const, title: 'My Hero Academia', year: '2016' }
  assert.deepEqual(historyPayload(mha, { season: 3, episode: 5 }, provable), {
    anime: [{ ids: { kitsu: 13881 }, episodes: [{ number: 5 }] }]
  })
  // Season 4 on the page is TMDB's fourth season; the member at place 4 is
  // an OVA. Sent there, episode 5 would be marked on the wrong entry.
  assert.deepEqual(historyPayload(mha, { season: 4, episode: 5 }, provable), {})
  assert.deepEqual(historyPayload(mha, { season: 5, episode: 5 }, provable), {})
  assert.equal(scrobblePayload(mha, { season: 4, episode: 5 }, 50, provable), null)
  assert.deepEqual(
    titleHistoryPayload(
      mha,
      [
        { season: 1, episodes: [1] },
        { season: 2, episodes: [1] },
        { season: 4, episodes: [1, 2] }
      ],
      provable
    ),
    {
      anime: [
        { title: 'My Hero Academia', year: 2016, ids: { kitsu: 11469 }, episodes: [{ number: 1 }] },
        { ids: { kitsu: 12268 }, episodes: [{ number: 1 }] }
      ]
    }
  )
})

// ---------------------------------------------------------------------------
console.log('\nrequest bodies')

check("marking season 2 episode 5 names the second season's entry, flat, by id alone", () => {
  // No title or year: they are the show's, which at Simkl are the first
  // season's, and Simkl falls back to them when it cannot place an id.
  assert.deepEqual(historyPayload(show, { season: 2, episode: 5 }, siblingsOf), {
    anime: [{ ids: { kitsu: 200 }, episodes: [{ number: 5 }] }]
  })
})

check('a first season keeps its title and year, and still sends no season', () => {
  assert.deepEqual(historyPayload(show, { season: 1, episode: 5 }, siblingsOf), {
    anime: [{ title: 'Bleach', year: 2004, ids: { kitsu: 100 }, episodes: [{ number: 5 }] }]
  })
  assert.deepEqual(historyPayload(alone, { episode: 9 }, siblingsOf), {
    anime: [{ title: 'Frieren', year: 2023, ids: { kitsu: 900 }, episodes: [{ number: 9 }] }]
  })
})

check("marking a season sends that season's entry its episodes", () => {
  assert.deepEqual(seasonHistoryPayload(show, 3, [2, 1, 3], siblingsOf), {
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
  assert.deepEqual(titleHistoryPayload(show, WHOLE_TITLE, siblingsOf), {
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
    historyPayload(show, { season: 0, episode: 1 }, siblingsOf),
    historyPayload(show, { season: 4, episode: 1 }, siblingsOf),
    historyPayload(show, {}, siblingsOf),
    seasonHistoryPayload(show, 0, [1, 2], siblingsOf),
    seasonHistoryPayload(show, 2, [], siblingsOf),
    titleHistoryPayload(show, [{ season: 0, episodes: [1] }], siblingsOf),
    titleHistoryPayload(show, [], siblingsOf)
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
    historyPayload(show, { season: 2, episode: 5 }, siblingsOf),
    historyPayload(show, { season: 2 }, siblingsOf),
    historyPayload(alone, {}, siblingsOf),
    seasonHistoryPayload(show, 1, [], siblingsOf),
    seasonHistoryPayload(show, 2, [0, 3], siblingsOf),
    titleHistoryPayload(show, WHOLE_TITLE, siblingsOf),
    titleHistoryPayload(show, WHOLE_TITLE),
    batchHistoryPayload(
      [{ item: show, playback: { season: 3, episode: 2 } }, { item: alone }],
      siblingsOf
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
  assert.deepEqual(scrobblePayload(show, { season: 2, episode: 5 }, 42, siblingsOf), {
    progress: 42,
    anime: { ids: { kitsu: 200 } },
    episode: { number: 5 }
  })
  assert.deepEqual(scrobblePayload(show, { season: 1, episode: 5 }, 42, siblingsOf), {
    progress: 42,
    anime: { title: 'Bleach', year: 2004, ids: { kitsu: 100 } },
    episode: { number: 5 }
  })
  // A one-off with no episode coordinate is its entry's only episode.
  assert.deepEqual(scrobblePayload(alone, {}, 10, siblingsOf)?.episode, { number: 1 })
  assert.equal(scrobblePayload(show, { season: 0, episode: 1 }, 42, siblingsOf), null)
  assert.equal(scrobblePayload(show, { season: 4, episode: 1 }, 42, siblingsOf), null)
})

check('a series and a film are built exactly as before', () => {
  const series = { id: 'tt0903747', type: 'series' as const, title: 'Breaking Bad', year: '2008' }
  assert.deepEqual(historyPayload(series, { season: 2, episode: 5 }, siblingsOf), {
    shows: [
      {
        title: 'Breaking Bad',
        year: 2008,
        ids: { imdb: 'tt0903747' },
        seasons: [{ number: 2, episodes: [{ number: 5 }] }]
      }
    ]
  })
  assert.deepEqual(scrobblePayload(series, { season: 2, episode: 5 }, 42, siblingsOf), {
    progress: 42,
    show: { title: 'Breaking Bad', year: 2008, ids: { imdb: 'tt0903747' } },
    episode: { season: 2, number: 5 }
  })
  const film = { id: 'tt0245429', type: 'movie' as const, title: 'Spirited Away', year: '2001' }
  assert.deepEqual(historyPayload(film, {}, siblingsOf), {
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
function caughtUp(library: unknown, watchedKeys: Iterable<string> = []): string[] {
  const { titles, dropped } = parseSimklLibrary({ anime: library })
  assert.equal(dropped, 0)
  const resolved: ResolvedTitle[] = titles.map((title) => {
    const target = targetOf(`kitsu:${title.kitsu}`)
    return { title, id: target.id, type: 'anime', animeSeason: target.season }
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
  account.add(titleHistoryPayload(show, bySeason(WATCHED), siblingsOf))
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
  account.remove(historyPayload(show, { season: 2, episode: 1 }, siblingsOf))
  assert.deepEqual(account.held(), { [SHOW]: [1, 2, 3], [SEASON_2]: [2], [SEASON_3]: [5] })
  account.remove(titleHistoryPayload(show, bySeason(WATCHED), siblingsOf))
  assert.deepEqual(account.held(), {})
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
  account.add(historyPayload(show, { season: 2, episode: 5 }, siblingsOf))
  assert.deepEqual(account.held(), { [SHOW]: [5], [SEASON_2]: [5] })
  assert.deepEqual(caughtUp(account.library(), [`${SHOW}:2:5`]), [])
})

check('a device that never held the later season takes the old one as season 1', () => {
  // The limit docs/WATCHLIST-SYNC.md states: nothing here can tell a
  // misfiled push from a first-season viewing made somewhere else.
  assert.deepEqual(caughtUp(misfiled().library()), [`${SHOW}:1:5`])
})

console.log(`\n${pass} passed`)
