// Unit tests for the anime catalog storage fixes (src/main/media-hub/core.ts's
// normalizeKitsuAnime lightweight mode, animeSeasons.ts's
// combineGroupEpisodeCounts) — from the anime catalog audit: the crawled
// catalog blob was ~59% throwaway placeholder-episode text nothing ever
// reads, and a grouped multi-season anime's browse-grid badge silently
// under-reported to just its first season's own count.
//
// Also the anime page's franchise guide: the story links, the kind of entry
// the grouping reads, and the two orders the page can list a franchise in —
// release order (the films between the seasons they came out between) and
// story order (core.ts's animeStoryOrder).
//
// Run with: npx tsx tests/animeCatalogStorage.test.ts   (or npm.cmd test)

import assert from 'node:assert'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import type {
  AnimeStoryLink,
  AnimeTimelineEntry,
  CatalogItem,
  Episode
} from '../src/shared/media-hub/types'
import { createDatabase } from '../src/main/media-hub/database'
import { setDatabase } from '../src/main/media-hub/dbState'
import {
  animeReleaseTimeline,
  animeStoryLinks,
  animeStoryOrder,
  animeStoryTimeline,
  mergedShowStoryLinks,
  normalizeKitsuAnime
} from '../src/main/media-hub/core'
import {
  ANIME_GROUPED_KEY,
  animeShowTimelineParts,
  combineGroupEpisodeCounts,
  groupedVideosAreComplete,
  invalidateAnimeGroupIndex,
  isSeasonEntry
} from '../src/main/media-hub/animeSeasons'

let pass = 0
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

function kitsuRecord(id: string, episodeCount: number) {
  return {
    id,
    attributes: {
      canonicalTitle: `Show ${id}`,
      episodeCount,
      startDate: '2020-01-01',
      genres: ['Action']
    }
  }
}

function anime(
  id: string,
  videos: Episode[],
  episodeCounts?: CatalogItem['episodeCounts']
): CatalogItem {
  return {
    id,
    title: `Show ${id}`,
    type: 'anime',
    poster: '',
    background: '',
    logo: '',
    year: '2020',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos,
    trailers: [],
    ...(episodeCounts ? { episodeCounts } : {})
  }
}

function episodes(count: number): Episode[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `ep${i + 1}`,
    season: 1,
    episode: i + 1,
    number: i + 1,
    title: `Episode ${i + 1}`,
    released: ''
  }))
}

console.log('normalizeKitsuAnime — lightweight mode')

check('default (non-lightweight) keeps the templated id/title, unchanged', () => {
  const item = normalizeKitsuAnime(kitsuRecord('123', 3))
  assert.equal(item.videos[0].id, 'kitsu:123:1:1')
  assert.equal(item.videos[0].title, 'Episode 1')
  assert.equal(item.videos[2].id, 'kitsu:123:1:3')
})

check('lightweight empties id/title but keeps every other field identical', () => {
  const full = normalizeKitsuAnime(kitsuRecord('123', 5))
  const light = normalizeKitsuAnime(kitsuRecord('123', 5), true)
  assert.equal(light.videos.length, full.videos.length, 'same episode count')
  for (let i = 0; i < full.videos.length; i++) {
    assert.equal(light.videos[i].season, full.videos[i].season)
    assert.equal(light.videos[i].episode, full.videos[i].episode)
    assert.equal(light.videos[i].number, full.videos[i].number)
    assert.equal(light.videos[i].released, full.videos[i].released)
    assert.equal(light.videos[i].id, '', `episode ${i + 1} id should be emptied`)
    assert.equal(light.videos[i].title, '', `episode ${i + 1} title should be emptied`)
  }
})

check('lightweight measurably shrinks the serialized payload', () => {
  const full = normalizeKitsuAnime(kitsuRecord('99999', 24))
  const light = normalizeKitsuAnime(kitsuRecord('99999', 24), true)
  const fullBytes = Buffer.byteLength(JSON.stringify(full.videos))
  const lightBytes = Buffer.byteLength(JSON.stringify(light.videos))
  assert.ok(lightBytes < fullBytes, `expected lightweight (${lightBytes}B) < full (${fullBytes}B)`)
})

check('a zero-episode title produces an empty array either way', () => {
  assert.deepEqual(normalizeKitsuAnime(kitsuRecord('1', 0)).videos, [])
  assert.deepEqual(normalizeKitsuAnime(kitsuRecord('1', 0), true).videos, [])
})

console.log('\nanimeStoryLinks')

check(
  'keeps every franchise relation, ordered before / alongside / after, and preserves availability status',
  () => {
    const links = animeStoryLinks({
      data: [
        { attributes: { role: 'sequel' }, relationships: { destination: { data: { id: '2' } } } },
        { attributes: { role: 'prequel' }, relationships: { destination: { data: { id: '3' } } } },
        { attributes: { role: 'spin_off' }, relationships: { destination: { data: { id: '4' } } } },
        { attributes: { role: 'sequel' }, relationships: { destination: { data: { id: '2' } } } }
      ],
      included: [
        {
          id: '2',
          type: 'anime',
          attributes: { canonicalTitle: 'Story After', status: 'upcoming' }
        },
        {
          id: '3',
          type: 'anime',
          attributes: { canonicalTitle: 'Story Before', status: 'finished' }
        },
        { id: '4', type: 'anime', attributes: { canonicalTitle: 'Spin-off', status: 'finished' } }
      ]
    })
    assert.deepEqual(
      links.map((link) => [link.relation, link.item.title, link.item.status]),
      [
        ['prequel', 'Story Before', 'finished'],
        ['spin_off', 'Spin-off', 'finished'],
        ['sequel', 'Story After', 'upcoming']
      ]
    )
  }
)

console.log('\nmergedShowStoryLinks')

// A show merged from three seasons: kitsu:100 fronts it. Kitsu links one
// season to the next, so asked of its own id the show's "sequel" is its own
// second season — already on its page.
const MERGED = ['kitsu:100', 'kitsu:200', 'kitsu:300']

function storyLink(relation: AnimeStoryLink['relation'], id: string): AnimeStoryLink {
  return { relation, item: anime(id, []) }
}

function storyShape(links: AnimeStoryLink[]): string[] {
  return links.map((link) => `${link.relation}:${link.item.id}`)
}

check('what follows a merged show is what follows its last season', () => {
  const first = [
    storyLink('prequel', 'kitsu:50'),
    storyLink('side_story', 'kitsu:60'),
    storyLink('sequel', 'kitsu:200')
  ]
  const last = [storyLink('prequel', 'kitsu:200'), storyLink('sequel', 'kitsu:400')]
  assert.deepEqual(storyShape(mergedShowStoryLinks(MERGED, first, last)), [
    'prequel:kitsu:50',
    'side_story:kitsu:60',
    'sequel:kitsu:400'
  ])
})

check('a link to a season of the show itself is dropped, whatever it is called', () => {
  const first = [storyLink('side_story', 'kitsu:300'), storyLink('sequel', 'kitsu:200')]
  // The last season's own "before" is the season before it, and its recap
  // is not the show's: only its sequel is taken.
  const last = [
    storyLink('prequel', 'kitsu:200'),
    storyLink('summary', 'kitsu:70'),
    storyLink('parent_story', 'kitsu:100')
  ]
  assert.deepEqual(storyShape(mergedShowStoryLinks(MERGED, first, last)), [])
})

check('a show whose last season has nothing after it lists no sequel', () => {
  const first = [storyLink('prequel', 'kitsu:50'), storyLink('sequel', 'kitsu:200')]
  const last = [storyLink('prequel', 'kitsu:200')]
  assert.deepEqual(storyShape(mergedShowStoryLinks(MERGED, first, last)), ['prequel:kitsu:50'])
})

check(
  'lightweight still preserves real season/episode positions — the exact thing a "Completed" badge is computed from',
  () => {
    // This is the regression an earlier version of this fix would have
    // shipped: emptying the whole array, not just id/title, would have
    // made every anime in the browse grid read as "0 episodes aired."
    const light = normalizeKitsuAnime(kitsuRecord('1', 12), true)
    assert.equal(light.videos.length, 12)
    assert.deepEqual(
      light.videos.map((v) => [v.season, v.episode]),
      Array.from({ length: 12 }, (_, i) => [1, i + 1])
    )
  }
)

console.log('\ncombineGroupEpisodeCounts')

check('a single-member group just reflects that member', () => {
  const result = combineGroupEpisodeCounts([anime('a', episodes(12))])
  assert.deepEqual(result, { totalSeasons: 1, totalEpisodes: 12 })
})

check('sums episode counts across every season, counts seasons by member count', () => {
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(13)),
    anime('s2', episodes(25)),
    anime('s3', episodes(13))
  ])
  assert.deepEqual(result, { totalSeasons: 3, totalEpisodes: 51 })
})

check("prefers a member's own episodeCounts hint over deriving from videos.length", () => {
  // Exercises the defensive fallback path directly — a member that
  // already carries a combined hint (shouldn't normally happen for a
  // single season, but the reduce must not silently double-count if it
  // ever does).
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(1), { totalSeasons: 1, totalEpisodes: 999 }),
    anime('s2', episodes(10))
  ])
  assert.equal(result.totalEpisodes, 1009)
})

check('an empty group is zero, not a crash', () => {
  assert.deepEqual(combineGroupEpisodeCounts([]), { totalSeasons: 0, totalEpisodes: 0 })
})

check('matches the real shape a franchise crawl produces (season counts vary per cour)', () => {
  // Modeled on the audit's own real example: Boku no Hero Academia-style,
  // uneven per-season episode counts, several seasons.
  const result = combineGroupEpisodeCounts([
    anime('s1', episodes(13)),
    anime('s2', episodes(25)),
    anime('s3', episodes(25)),
    anime('s4', episodes(25)),
    anime('s5', episodes(25))
  ])
  assert.deepEqual(result, { totalSeasons: 5, totalEpisodes: 113 })
})

// The completeness check a grouped build is cached by (see catalog.ts's
// DEGRADED_META_TTL_MS): every season position 1..N+1 must have episodes;
// the Specials block is optional; an empty build is never complete.
check('groupedVideosAreComplete: an empty build with siblings is incomplete', () => {
  assert.equal(groupedVideosAreComplete(2, []), false)
})
check('groupedVideosAreComplete: every position present is complete, specials optional', () => {
  const ep = (season: number, episode: number): Episode => ({
    id: `${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: '',
    released: ''
  })
  assert.equal(groupedVideosAreComplete(2, [ep(1, 1), ep(2, 1), ep(3, 1)]), true)
  assert.equal(groupedVideosAreComplete(2, [ep(0, 1), ep(1, 1), ep(2, 1), ep(3, 1)]), true)
  assert.equal(groupedVideosAreComplete(2, [ep(1, 1), ep(3, 1)]), false, 'season 2 missing')
  assert.equal(groupedVideosAreComplete(0, [ep(1, 1)]), true, 'an ungrouped title is one season')
})

// English first, romaji kept: the name most people know a show by is the
// title, and the source's own name survives as originalTitle for search and
// for matching release names (which are romaji).
check('normalizeKitsuAnime prefers the English title and keeps the romaji as originalTitle', () => {
  const item = normalizeKitsuAnime({
    id: '7442',
    attributes: {
      canonicalTitle: 'Shingeki no Kyojin',
      titles: { en: 'Attack on Titan', en_jp: 'Shingeki no Kyojin' },
      episodeCount: 25
    }
  })
  assert.equal(item.title, 'Attack on Titan')
  assert.equal(item.originalTitle, 'Shingeki no Kyojin')
})
check(
  'normalizeKitsuAnime falls back to the romaji, with no originalTitle, when Kitsu has no English name',
  () => {
    const item = normalizeKitsuAnime({
      id: '1',
      attributes: {
        canonicalTitle: 'Cowboy Bebop',
        titles: { en_jp: 'Cowboy Bebop' },
        episodeCount: 26
      }
    })
    assert.equal(item.title, 'Cowboy Bebop')
    assert.equal(item.originalTitle, undefined)
  }
)

// The kind of entry decides whether the grouping may make it a season
// (animeSeasons.ts's isSeasonEntry): only a TV entry is one.
check("normalizeKitsuAnime keeps Kitsu's kind of entry, lowercased", () => {
  const kind = (attributes: Record<string, unknown>): string | undefined =>
    normalizeKitsuAnime({ id: '1', attributes: { canonicalTitle: 'x', ...attributes } }).subtype
  assert.equal(kind({ subtype: 'TV' }), 'tv')
  assert.equal(kind({ subtype: 'movie' }), 'movie')
  assert.equal(kind({ subtype: 'OVA', showType: 'OVA' }), 'ova')
  assert.equal(kind({ showType: 'ONA' }), 'ona')
  assert.equal(kind({}), undefined, 'none given: the key is absent, not empty')
  assert.equal(isSeasonEntry({ subtype: 'tv' }), true)
  assert.equal(isSeasonEntry({}), true, 'unknown is grouped as it always was')
  for (const subtype of ['movie', 'ova', 'ona', 'special', 'music']) {
    assert.equal(isSeasonEntry({ subtype }), false, subtype)
  }
})

console.log('\nrelease order and story order')

// A franchise to put in order: a show of three seasons, a film that came
// out between its second and third, an OVA after the third, a prequel made
// years later and a side story with no prequel or sequel link at all.
function dated(id: string, releaseDate: string, subtype = 'tv'): CatalogItem {
  return { ...anime(id, []), releaseDate, subtype }
}
const S1 = dated('kitsu:1', '2013-04-07')
const S2 = dated('kitsu:2', '2017-04-01')
const S3 = dated('kitsu:3', '2019-04-29')
const FILM = dated('kitsu:4', '2018-07-20', 'movie')
const OVA = dated('kitsu:5', '2020-01-10', 'ova')
const EARLY = dated('kitsu:6', '2012-12-01', 'special')
const UNDATED = dated('kitsu:7', '', 'ova')
const ids = (entries: { item: CatalogItem }[]): string[] => entries.map((entry) => entry.item.id)
const storyLinkTo = (relation: AnimeStoryLink['relation'], item: CatalogItem): AnimeStoryLink => ({
  relation,
  item
})
const seasons = [S1, S2, S3].map((item, i) => ({ item, season: i + 1 }))

check('release order: each film between the seasons it came out between', () => {
  const timeline = animeReleaseTimeline(
    seasons,
    [OVA, UNDATED, FILM, EARLY].map((item) => ({ item }))
  )
  assert.deepEqual(
    ids(timeline),
    [EARLY, S1, S2, FILM, S3, OVA, UNDATED].map((item) => item.id)
  )
  // The seasons keep their numbers and their order.
  assert.deepEqual(
    timeline
      .filter((entry) => 'season' in entry)
      .map((entry) => (entry as { season: number }).season),
    [1, 2, 3]
  )
})

check('release order: a season with no date does not place anything', () => {
  const undatedSecond = [S1, { ...S2, releaseDate: '' }, S3].map((item, i) => ({
    item,
    season: i + 1
  }))
  // Measured from the first season, the last that started before it.
  assert.deepEqual(ids(animeReleaseTimeline(undatedSecond, [{ item: FILM }])), [
    S1.id,
    FILM.id,
    S2.id,
    S3.id
  ])
})

const key = (item: CatalogItem): string => item.id
const date = (item: CatalogItem): string => String(item.releaseDate || '')

check('story order follows the prequel and sequel links, not the air dates', () => {
  // A prequel made later (the Fate/Zero shape): linked as the prequel of
  // the first season, it goes first though it aired last.
  const PREQUEL = dated('kitsu:8', '2021-10-01')
  const order = animeStoryOrder([S1, S2, S3, PREQUEL], key, date, [
    [PREQUEL.id, S1.id],
    [S1.id, S2.id],
    [S2.id, S3.id]
  ])
  assert.deepEqual(order.map(key), [PREQUEL, S1, S2, S3].map(key))
})

check('story order places what the links leave unordered by its date', () => {
  // The film and the OVA have no link among these: each lands between the
  // parts around its date. The undated one comes last.
  const order = animeStoryOrder([S3, OVA, UNDATED, FILM, S2, S1], key, date, [
    [S1.id, S2.id],
    [S2.id, S3.id]
  ])
  assert.deepEqual(order.map(key), [S1, S2, FILM, S3, OVA, UNDATED].map(key))
})

check('story order: a link the dates disagree with wins, and a cycle loses nothing', () => {
  // The film is linked as the third season's sequel, though it aired first.
  const order = animeStoryOrder([S1, S2, S3, FILM], key, date, [
    [S1.id, S2.id],
    [S2.id, S3.id],
    [S3.id, FILM.id]
  ])
  assert.deepEqual(order.map(key), [S1, S2, S3, FILM].map(key))
  // Each listed as the other's prequel: broken at the earlier one.
  const cycle = animeStoryOrder([S2, S1], key, date, [
    [S1.id, S2.id],
    [S2.id, S1.id]
  ])
  assert.deepEqual(cycle.map(key), [S1, S2].map(key))
  // Links to anything not in the list, and to itself, are ignored.
  assert.deepEqual(
    animeStoryOrder([S2, S1], key, date, [
      ['kitsu:404', S1.id],
      [S2.id, S2.id]
    ]).map(key),
    [S1, S2].map(key)
  )
})

// What the page's catalog:story is answered from (animeStory.ts's
// storyForShow, which adds only the IPC handler and the requests): the
// show's parts from the grouped catalog and the index, put in release order,
// or with each part's story links in story order. Everything is cached here
// first, so nothing is asked of Kitsu.
async function pageChecks(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-anime-story-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile')
  setDatabase(db)
  const PREQUEL = dated('kitsu:20', '2010-01-01')
  const SIDE = dated('kitsu:21', '2018-01-05', 'ova')
  const NEXT = dated('kitsu:22', '2022-04-01')
  const show: CatalogItem = {
    ...S1,
    groupedIds: [S2.id, S3.id],
    groupedExtras: [FILM.id],
    seasonStarts: [S1.releaseDate!, S2.releaseDate!, S3.releaseDate!]
  }
  db.putCache('catalog:v2:anime', [show, FILM, NEXT], 60_000)
  db.putCache(ANIME_GROUPED_KEY, true, 60_000)
  invalidateAnimeGroupIndex()
  // The index rows carry a year and no date, as indexRowToItem gives them.
  db.indexUpsert('anime', [S1, S2, S3, FILM, NEXT])
  const story: Record<string, AnimeStoryLink[]> = {
    [S1.id]: [storyLinkTo('prequel', PREQUEL), storyLinkTo('sequel', S2)],
    [S2.id]: [
      storyLinkTo('prequel', S1),
      storyLinkTo('side_story', SIDE),
      storyLinkTo('sequel', S3)
    ],
    [S3.id]: [storyLinkTo('prequel', S2), storyLinkTo('sequel', NEXT)],
    [FILM.id]: [storyLinkTo('parent_story', S2)]
  }
  const shape = (entries: AnimeTimelineEntry[]): string[] =>
    entries.map((entry) =>
      entry.season !== undefined
        ? `season ${entry.season}`
        : `${entry.relation ?? entry.item.subtype}:${entry.item.id}`
    )

  await checkAsync('the show’s parts: its seasons, named and dated, then its films', async () => {
    const parts = animeShowTimelineParts(S1.id)
    assert.deepEqual(shape(parts), ['season 1', 'season 2', 'season 3', `movie:${FILM.id}`])
    assert.equal(parts[1].item.title, S2.title, 'a season is named by its own entry')
    assert.equal(parts[1].item.releaseDate, S2.releaseDate, 'and dated by the grouping')
    // A title that is not a merged show is its one part.
    assert.deepEqual(
      animeShowTimelineParts(NEXT.id).map((part) => [part.item.id, part.season]),
      [[NEXT.id, undefined]]
    )
  })

  await checkAsync('release order lists the film between the seasons, as released', async () => {
    const parts = animeShowTimelineParts(S1.id)
    const timeline = animeReleaseTimeline(
      parts.filter((part) => part.season !== undefined),
      parts.filter((part) => part.season === undefined)
    )
    assert.deepEqual(shape(timeline), ['season 1', 'season 2', `movie:${FILM.id}`, 'season 3'])
  })

  await checkAsync('story order lists every part and every link, in story order', async () => {
    const parts = animeShowTimelineParts(S1.id)
    const { timeline, timelineChecked } = animeStoryTimeline(
      parts,
      parts.map((part) => ({ links: story[part.item.id] ?? [], checked: true }))
    )
    assert.equal(timelineChecked, true)
    assert.deepEqual(shape(timeline), [
      `prequel:${PREQUEL.id}`,
      'season 1',
      'season 2',
      `side_story:${SIDE.id}`,
      `movie:${FILM.id}`,
      'season 3',
      `sequel:${NEXT.id}`
    ])
  })

  await checkAsync('story order says so when a part’s links could not be looked up', async () => {
    const parts = animeShowTimelineParts(S1.id)
    // The film's lookup failed with nothing cached, and the third season's
    // failed outright: the order is built from what answered.
    const { timeline, timelineChecked } = animeStoryTimeline(
      parts,
      parts.map((part) =>
        part.item.id === FILM.id
          ? { links: [], checked: false }
          : part.item.id === S3.id
            ? null
            : { links: story[part.item.id] ?? [], checked: true }
      )
    )
    assert.equal(timelineChecked, false)
    assert.deepEqual(shape(timeline), [
      `prequel:${PREQUEL.id}`,
      'season 1',
      'season 2',
      `side_story:${SIDE.id}`,
      `movie:${FILM.id}`,
      'season 3'
    ])
  })
  db.close()
}

void pageChecks().then(() => console.log(`\n${pass} passed`))
