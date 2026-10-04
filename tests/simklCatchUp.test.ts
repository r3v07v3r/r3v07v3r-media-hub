// The catch-up: what the phone and TV app take from Simkl, unattended.
//
// Nobody reviews a catch-up before it writes. It runs whenever the app comes
// to the front, into the same table every badge, row and recommendation is
// derived from, so the judgement is pinned here directly
// (simklCatchUpRules.ts): what a Simkl payload means, when a kind is worth
// fetching, and which rows a changed title becomes. Then once end to end
// against a real database, because the property that matters most — a
// second pass over the same library changes nothing — is a property of the
// rules and importWatched together. Then the pass that carries them out
// (simklCatchUp.ts), with the services faked: what it asks Simkl for, and
// what it refuses to write when something moves underneath it.
//
// Run with: npx tsx tests/simklCatchUp.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import { continueWatchingList } from '../src/main/media-hub/core'
import {
  fillTrackedArtwork,
  newCatchUpMemory,
  runCatchUp,
  type CatchUpDeps,
  type CatchUpMemory
} from '../src/main/media-hub/simklCatchUp'
import {
  FOLLOW_WINDOW_MS,
  FULL_REFETCH_MS,
  UNSTAMPED_REFETCH_MS,
  catchUpStateFor,
  emptyCatchUpState,
  kindsToFetch,
  librarySince,
  parseSimklActivities,
  parseSimklLibrary,
  planCatchUp,
  titleSignature,
  type CatchUpLocal,
  type CatchUpState,
  type ResolvedTitle,
  type SimklLibraryKind,
  type SimklLibraryTitle
} from '../src/main/media-hub/simklCatchUpRules'
import type { CatalogItem, CatchUpReport, Episode, MediaKind } from '../src/shared/media-hub/types'

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

const NOW = new Date('2026-09-20T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function title(over: Partial<SimklLibraryTitle> = {}): SimklLibraryTitle {
  return {
    kind: 'show',
    ref: 'simkl:1',
    status: 'watching',
    title: 'Severance',
    year: '2022',
    lastWatchedAt: '2026-09-19T21:00:00Z',
    addedAt: null,
    watchedCount: 2,
    episodes: [
      { season: 1, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 2, watchedAt: '2026-09-19T21:00:00Z' }
    ],
    ...over
  }
}

function resolved(t: SimklLibraryTitle, over: Partial<ResolvedTitle> = {}): ResolvedTitle {
  return {
    title: t,
    id: t.kind === 'anime' ? 'kitsu:100' : t.kind === 'movie' ? 'tt0000002' : 'tt0000001',
    type: t.kind === 'anime' ? 'anime' : t.kind === 'movie' ? 'movie' : 'series',
    animeSeason: t.kind === 'anime' ? 1 : null,
    ...over
  }
}

function local(over: Partial<CatchUpLocal> = {}): CatchUpLocal {
  return { watchedKeys: new Set(), trackedIds: new Set(), awaitingRemoval: new Set(), ...over }
}

// ---------------------------------------------------------------------------
console.log('parseSimklLibrary')

check('a completed film, ids as numeric strings', () => {
  const { titles, dropped } = parseSimklLibrary({
    movies: {
      movies: [
        {
          movie: { title: 'Dune', year: 2021, ids: { simkl: '342994', imdb: 'tt1160419' } },
          status: 'Completed',
          last_watched_at: '2026-01-02T20:00:00Z',
          added_to_watchlist_at: '2025-12-01T00:00:00Z'
        }
      ]
    }
  })
  assert.equal(dropped, 0)
  assert.deepEqual(titles, [
    {
      kind: 'movie',
      ref: 'simkl:342994',
      status: 'completed',
      title: 'Dune',
      year: '2021',
      imdb: 'tt1160419',
      lastWatchedAt: '2026-01-02T20:00:00Z',
      addedAt: '2025-12-01T00:00:00Z',
      watchedCount: null,
      episodes: []
    }
  ])
})

check('identity falls back to IMDb, and an entry with none is dropped and counted', () => {
  const { titles, dropped } = parseSimklLibrary({
    movies: {
      movies: [
        { movie: { title: 'Only IMDb', ids: { imdb: 'tt0000009' } }, status: 'completed' },
        { movie: { title: 'Nothing', ids: {} }, status: 'completed' },
        // Not an IMDb title id, and no other id: nothing to remember it by.
        { movie: { title: 'A person id', ids: { imdb: 'nm0000001', simkl: 0 } } },
        null,
        5
      ]
    }
  })
  assert.deepEqual(
    titles.map((t) => t.ref),
    ['imdb:tt0000009']
  )
  assert.equal(dropped, 4)
})

check('a show: seasons, bad dates, season 0, an unreadable season', () => {
  const { titles, dropped } = parseSimklLibrary({
    shows: {
      shows: [
        {
          show: {
            title: 'Severance',
            year: '2022',
            ids: { simkl: 7, imdb: 'tt11280740', tvdb: 1 }
          },
          status: 'watching',
          last_watched_at: '2026-09-19T21:00:00Z',
          watched_episodes_count: '3',
          seasons: [
            {
              number: 1,
              episodes: [
                { number: 1, watched_at: '2026-09-18T21:00:00Z' },
                // No usable date: not a viewing. importWatched would roll the
                // whole batch back on it.
                { number: 2, watched_at: 'sometime' },
                { number: 3, watched_at: '' },
                { number: 4 },
                // Not an episode number.
                { number: 0, watched_at: '2026-09-18T21:00:00Z' },
                { number: '5', watched_at: '2026-09-19T21:00:00Z' }
              ]
            },
            // Season 0 is the specials, not a missing season.
            { number: 0, episodes: [{ number: 1, watched_at: '2026-09-17T21:00:00Z' }] },
            // Present but unreadable: dropped whole, never guessed at.
            { number: 'x', episodes: [{ number: 1, watched_at: '2026-09-17T21:00:00Z' }] },
            { number: -1, episodes: [{ number: 1, watched_at: '2026-09-17T21:00:00Z' }] }
          ]
        }
      ]
    }
  })
  assert.equal(dropped, 0)
  assert.equal(titles.length, 1)
  const show = titles[0]
  assert.equal(show.kind, 'show')
  assert.equal(show.ref, 'simkl:7')
  assert.equal(show.imdb, 'tt11280740')
  assert.equal(show.watchedCount, 3)
  assert.deepEqual(show.episodes, [
    { season: 1, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
    { season: 1, episode: 5, watchedAt: '2026-09-19T21:00:00Z' },
    { season: 0, episode: 1, watchedAt: '2026-09-17T21:00:00Z' }
  ])
})

check('anime in the shows list is ignored, and not counted as dropped', () => {
  const { titles, dropped } = parseSimklLibrary({
    shows: {
      shows: [
        { show: { title: 'Typed', ids: { simkl: 1, imdb: 'tt1' } }, anime_type: 'tv' },
        { show: { title: 'MAL id', ids: { simkl: 2, mal: 5114 } } },
        { show: { title: 'Kitsu id', ids: { simkl: 3, kitsu: '42' } } },
        { show: { title: 'AniDB id', ids: { simkl: 4, anidb: 9 } } },
        { show: { title: 'Plain', ids: { simkl: 5, imdb: 'tt0000005' } } }
      ]
    }
  })
  assert.deepEqual(
    titles.map((t) => t.title),
    ['Plain']
  )
  assert.equal(dropped, 0)
})

check('anime: string ids, the type, flat episodes with no season', () => {
  const { titles } = parseSimklLibrary({
    anime: {
      anime: [
        {
          show: {
            title: 'Frieren',
            year: 2023,
            ids: { simkl: '1', mal: '52991', kitsu: '46474', anidb: 'abc' }
          },
          anime_type: 'TV',
          status: 'watching',
          last_watched_at: '2026-09-19T21:00:00Z',
          watched_episodes_count: 2,
          seasons: [{ episodes: [{ number: 1, watched_at: '2026-09-18T21:00:00Z' }] }],
          episodes: [{ number: 2, watched_at: '2026-09-19T21:00:00Z' }]
        },
        // Anime with no Simkl id is still identifiable by its Kitsu one.
        {
          show: { title: 'No Simkl', ids: { kitsu: 7 } },
          anime_type: 'movie',
          status: 'completed'
        },
        // AniDB alone is still something the resolver can look a Kitsu id up by.
        { show: { title: 'AniDB only', ids: { anidb: 9 } } }
      ]
    }
  })
  assert.equal(titles.length, 3)
  const [frieren, film, anidbOnly] = titles
  assert.equal(anidbOnly.ref, 'anidb:9')
  assert.equal(frieren.kind, 'anime')
  assert.equal(frieren.ref, 'simkl:1')
  assert.equal(frieren.kitsu, 46474)
  assert.equal(frieren.mal, 52991)
  assert.equal(frieren.anidb, undefined, 'a non-numeric id is no id')
  assert.equal(frieren.animeType, 'tv')
  assert.equal(frieren.year, '2023')
  assert.deepEqual(frieren.episodes, [
    { season: null, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
    { season: null, episode: 2, watchedAt: '2026-09-19T21:00:00Z' }
  ])
  assert.equal(film.ref, 'kitsu:7')
  assert.equal(film.animeType, 'movie')
})

check('anything that is not the expected shape is empty, never a throw', () => {
  assert.deepEqual(parseSimklLibrary({}), { titles: [], dropped: 0 })
  assert.deepEqual(parseSimklLibrary({ movies: 'x', shows: null, anime: { anime: 5 } }), {
    titles: [],
    dropped: 0
  })
  assert.deepEqual(parseSimklLibrary({ movies: [{ movie: {} }] }), { titles: [], dropped: 0 })
  assert.deepEqual(parseSimklLibrary(null as unknown as { movies?: unknown }), {
    titles: [],
    dropped: 0
  })
  const odd = parseSimklLibrary({
    shows: { shows: [{ show: { ids: { simkl: 9 } }, seasons: 'no', status: 4 }] }
  })
  assert.equal(odd.titles.length, 1)
  assert.deepEqual(odd.titles[0].episodes, [])
  assert.equal(odd.titles[0].status, '')
  assert.equal(odd.titles[0].year, undefined)
})

// ---------------------------------------------------------------------------
console.log('parseSimklActivities')

check('the documented shape, with shows under tv_shows', () => {
  assert.deepEqual(
    parseSimklActivities({
      all: '2026-09-20T10:00:00Z',
      movies: { all: '2026-09-01T00:00:00Z', rated_at: 'x' },
      tv_shows: { all: '2026-09-19T00:00:00Z' },
      anime: { all: '2026-09-18T00:00:00Z' }
    }),
    { movies: '2026-09-01T00:00:00Z', shows: '2026-09-19T00:00:00Z', anime: '2026-09-18T00:00:00Z' }
  )
})

check('a missing or non-string stamp is null', () => {
  assert.deepEqual(
    parseSimklActivities({ movies: { all: 12 }, shows: { all: '2026-09-19T00:00:00Z' } }),
    { movies: null, shows: null, anime: null },
    'a `shows` key is not where Simkl puts it'
  )
  assert.deepEqual(parseSimklActivities('nope'), { movies: null, shows: null, anime: null })
  assert.deepEqual(parseSimklActivities(undefined), { movies: null, shows: null, anime: null })
})

// ---------------------------------------------------------------------------
console.log('state and kindsToFetch')

const STAMPS = { movies: 'm1', shows: 's1', anime: 'a1' }

check('a first pass fetches every kind', () => {
  assert.deepEqual(kindsToFetch(emptyCatchUpState('acct'), STAMPS, NOW.getTime()), [
    'movie',
    'show',
    'anime'
  ])
})

const FETCHED = {
  movies: NOW.getTime() - 1000,
  shows: NOW.getTime() - 1000,
  anime: NOW.getTime() - 1000
}

check('unchanged stamps fetch nothing; a moved one fetches that kind only', () => {
  const state = { ...emptyCatchUpState('acct'), stamps: { ...STAMPS }, fetchedAt: { ...FETCHED } }
  assert.deepEqual(kindsToFetch(state, STAMPS, NOW.getTime()), [])
  assert.deepEqual(kindsToFetch(state, { ...STAMPS, shows: 's2' }, NOW.getTime()), ['show'])
  // A stamp that appears, or goes away, is a move like any other.
  assert.deepEqual(kindsToFetch(state, { ...STAMPS, anime: null }, NOW.getTime()), ['anime'])
})

check('a kind Simkl gives no stamp for is not refetched for having none', () => {
  // An account with no anime has no anime stamp, permanently. Read as
  // "changed", that library would be fetched on every pass.
  const at = NOW.getTime()
  const none = { movies: null, shows: null, anime: null }
  const state = {
    ...emptyCatchUpState('acct'),
    fetchedAt: { movies: at - 60 * 60 * 1000, shows: at - UNSTAMPED_REFETCH_MS, anime: 0 }
  }
  assert.deepEqual(
    kindsToFetch(state, none, at),
    ['show', 'anime'],
    'a day since its last read, and one that has never been read'
  )
  // A clock set back must not strand a kind in the future.
  const ahead = { ...state, fetchedAt: { movies: at + 1000, shows: at - 1, anime: at - 1 } }
  assert.deepEqual(kindsToFetch(ahead, none, at), ['movie'])
})

check('a kind is fetched whole first, then only what changed, and whole again weekly', () => {
  const at = NOW.getTime()
  const fresh = emptyCatchUpState('acct')
  assert.equal(librarySince(fresh, 'show', at), null, 'never fetched: whole')
  const applied = {
    ...fresh,
    stamps: { movies: null, shows: 's1', anime: 'a1' },
    fullAt: { movies: at - 1000, shows: at - 1000, anime: 0 }
  }
  assert.equal(librarySince(applied, 'show', at), 's1', 'the stamp the last fetch was made under')
  assert.equal(librarySince(applied, 'movie', at), null, 'no stamp to ask from')
  assert.equal(librarySince(applied, 'anime', at), null, 'a stamp, but never fetched whole')
  const old = { ...applied, fullAt: { ...applied.fullAt, shows: at - FULL_REFETCH_MS } }
  assert.equal(librarySince(old, 'show', at), null, 'a week on: whole again')
  const ahead = { ...applied, fullAt: { ...applied.fullAt, shows: at + 1000 } }
  assert.equal(librarySince(ahead, 'show', at), null, 'a clock set back reads as due')
})

check('stored state is used only for the same account and when well formed', () => {
  const good = {
    account: 'acct',
    stamps: { movies: 'm1', shows: null, anime: 'a1' },
    fetchedAt: { movies: 1, shows: 2, anime: 3 },
    fullAt: { movies: 1, shows: 0, anime: 3 },
    seen: { 'simkl:1': 'x|1|watching' }
  }
  assert.deepEqual(catchUpStateFor(good, 'acct'), good)
  // A record written before whole fetches were timed has never been fetched
  // whole as far as anybody can tell: it is kept, and the next fetch is whole.
  const { fullAt: _fullAt, ...untimed } = good
  void _fullAt
  assert.deepEqual(catchUpStateFor(untimed, 'acct'), {
    ...good,
    fullAt: { movies: 0, shows: 0, anime: 0 }
  })
  assert.deepEqual(catchUpStateFor(good, 'other'), emptyCatchUpState('other'))
  assert.deepEqual(catchUpStateFor(null, 'acct'), emptyCatchUpState('acct'))
  assert.deepEqual(catchUpStateFor('x', 'acct'), emptyCatchUpState('acct'))
  assert.deepEqual(catchUpStateFor({ ...good, seen: { a: 5 } }, 'acct'), emptyCatchUpState('acct'))
  assert.deepEqual(
    catchUpStateFor({ ...good, fetchedAt: { movies: 1 } }, 'acct'),
    emptyCatchUpState('acct')
  )
  assert.deepEqual(
    catchUpStateFor({ ...good, stamps: { movies: 4, shows: null, anime: null } }, 'acct'),
    emptyCatchUpState('acct')
  )
})

check('the signature moves with the count even when the date does not', () => {
  const base = title()
  assert.equal(titleSignature(base), '2026-09-19T21:00:00Z|2|watching')
  assert.notEqual(titleSignature({ ...base, watchedCount: 3 }), titleSignature(base))
  assert.notEqual(titleSignature({ ...base, status: 'hold' }), titleSignature(base))
  assert.equal(titleSignature({ ...base, lastWatchedAt: null, watchedCount: null }), '||watching')
})

// ---------------------------------------------------------------------------
console.log('planCatchUp')

check('R1: an unchanged title is left alone entirely', () => {
  const t = title()
  const plan = planCatchUp([resolved(t)], local(), { [t.ref]: titleSignature(t) }, NOW)
  assert.deepEqual(plan, { plays: [], follow: [], unplan: [], seen: {}, rejected: 0 })
})

check('R1: a show removed here is not followed again until it moves at Simkl', () => {
  const t = title()
  const seen = { [t.ref]: titleSignature(t) }
  assert.equal(planCatchUp([resolved(t)], local(), seen, NOW).follow.length, 0)
  const moved = title({ watchedCount: 3, lastWatchedAt: '2026-09-20T09:00:00Z' })
  assert.equal(planCatchUp([resolved(moved)], local(), seen, NOW).follow.length, 1)
})

check('R2: show episodes become plays, keyed as importWatched keys them', () => {
  const plan = planCatchUp([resolved(title())], local(), {}, NOW)
  assert.deepEqual(plan.plays, [
    {
      id: 'tt0000001',
      type: 'series',
      title: 'Severance',
      year: '2022',
      season: 1,
      episode: 1,
      watchedAt: '2026-09-18T21:00:00Z'
    },
    {
      id: 'tt0000001',
      type: 'series',
      title: 'Severance',
      year: '2022',
      season: 1,
      episode: 2,
      watchedAt: '2026-09-19T21:00:00Z'
    }
  ])
  assert.equal(plan.rejected, 0)
})

check('R2: an episode already held locally is not offered again', () => {
  const plan = planCatchUp(
    [resolved(title())],
    local({ watchedKeys: new Set(['tt0000001:1:1']) }),
    {},
    NOW
  )
  assert.deepEqual(
    plan.plays.map((p) => `${p.season}:${p.episode}`),
    ['1:2'],
    'the same viewing, stamped differently by Simkl, would be a phantom rewatch'
  )
})

check('R2: a show episode with no season is season 1; season 0 stays 0', () => {
  const t = title({
    episodes: [
      { season: null, episode: 4, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 0, episode: 1, watchedAt: '2026-09-18T21:00:00Z' }
    ]
  })
  assert.deepEqual(
    planCatchUp([resolved(t)], local(), {}, NOW).plays.map((p) => [p.season, p.episode]),
    [
      [1, 4],
      [0, 1]
    ]
  )
})

check('R2: a film uses the last watched date, else the added date, else now', () => {
  const film = (over: Partial<SimklLibraryTitle>): ResolvedTitle =>
    resolved(
      title({
        kind: 'movie',
        ref: 'simkl:9',
        title: 'Dune',
        year: '2021',
        status: 'completed',
        episodes: [],
        ...over
      })
    )
  const dated = planCatchUp([film({ lastWatchedAt: '2026-01-02T20:00:00Z' })], local(), {}, NOW)
  assert.deepEqual(dated.plays, [
    {
      id: 'tt0000002',
      type: 'movie',
      title: 'Dune',
      year: '2021',
      season: null,
      episode: null,
      watchedAt: '2026-01-02T20:00:00Z'
    }
  ])
  const added = planCatchUp(
    [film({ lastWatchedAt: 'garbage', addedAt: '2025-12-01T00:00:00Z' })],
    local(),
    {},
    NOW
  )
  assert.equal(added.plays[0].watchedAt, '2025-12-01T00:00:00Z')
  const undated = planCatchUp([film({ lastWatchedAt: null, addedAt: null })], local(), {}, NOW)
  assert.equal(undated.plays[0].watchedAt, NOW.toISOString())
  const held = planCatchUp(
    [film({ lastWatchedAt: '2026-01-02T20:00:00Z' })],
    local({ watchedKeys: new Set(['tt0000002:movie:movie']) }),
    {},
    NOW
  )
  assert.deepEqual(held.plays, [])
})

check('R2: a film Simkl does not call completed is not taken as watched', () => {
  const plan = planCatchUp(
    [resolved(title({ kind: 'movie', ref: 'simkl:9', status: 'plantowatch', episodes: [] }))],
    local({ trackedIds: new Set(['tt0000002']) }),
    {},
    NOW
  )
  assert.deepEqual(plan.plays, [])
  assert.deepEqual(plan.unplan, [])
})

check('R2: anime episodes land in the season the entry resolved to', () => {
  const t = title({
    kind: 'anime',
    ref: 'simkl:50',
    title: 'Frieren',
    animeType: 'tv',
    episodes: [
      { season: null, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 2, watchedAt: '2026-09-19T21:00:00Z' }
    ]
  })
  const plan = planCatchUp([resolved(t, { animeSeason: 2 })], local(), {}, NOW)
  assert.deepEqual(
    plan.plays.map((p) => [p.id, p.type, p.season, p.episode]),
    [
      ['kitsu:100', 'anime', 2, 1],
      ['kitsu:100', 'anime', 2, 2]
    ]
  )
})

check('R2: an anime episode under Simkl season 0 or 2+ is refused, never guessed', () => {
  const t = title({
    kind: 'anime',
    ref: 'simkl:50',
    animeType: 'tv',
    episodes: [
      { season: 0, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 2, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 3, watchedAt: '2026-09-18T21:00:00Z' }
    ]
  })
  const plan = planCatchUp([resolved(t)], local(), {}, NOW)
  assert.deepEqual(
    plan.plays.map((p) => p.episode),
    [3]
  )
  assert.equal(plan.rejected, 2)
})

check('R2: anime with no season to land in is refused', () => {
  const t = title({ kind: 'anime', ref: 'simkl:50', animeType: 'tv' })
  const plan = planCatchUp([resolved(t, { animeSeason: null })], local(), {}, NOW)
  assert.deepEqual(plan.plays, [])
  assert.equal(plan.rejected, 2)
})

check('R2: the echo of a later season pushed from here is skipped, not rejected', () => {
  const t = title({
    kind: 'anime',
    ref: 'simkl:50',
    animeType: 'tv',
    episodes: [
      { season: 1, episode: 3, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 4, watchedAt: '2026-09-18T21:00:00Z' }
    ]
  })
  // Episode 3 was watched here as season 2 of the merged franchise.
  const plan = planCatchUp(
    [resolved(t)],
    local({ watchedKeys: new Set(['kitsu:100:2:3']) }),
    {},
    NOW
  )
  assert.deepEqual(
    plan.plays.map((p) => [p.season, p.episode]),
    [[1, 4]]
  )
  assert.equal(plan.rejected, 0)
  // Only for season 1: the same episode number in season 2 is not an echo.
  const second = planCatchUp(
    [resolved(t, { animeSeason: 2 })],
    local({ watchedKeys: new Set(['kitsu:100:3:3']) }),
    {},
    NOW
  )
  assert.deepEqual(
    second.plays.map((p) => [p.season, p.episode]),
    [
      [2, 3],
      [2, 4]
    ]
  )
})

check('R2: a key produced twice in one plan is emitted once', () => {
  const a = title({ kind: 'anime', ref: 'simkl:50', animeType: 'tv' })
  const b = title({ kind: 'anime', ref: 'simkl:51', animeType: 'tv' })
  const plan = planCatchUp([resolved(a), resolved(b)], local(), {}, NOW)
  assert.equal(plan.plays.length, 2)
  assert.deepEqual(Object.keys(plan.seen), ['simkl:50', 'simkl:51'])
})

check('R2: a row with a bad date or coordinates is refused and counted', () => {
  const t = title({
    episodes: [
      { season: 1, episode: 1, watchedAt: 'never' },
      { season: 1.5, episode: 1, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 0, watchedAt: '2026-09-18T21:00:00Z' },
      { season: -1, episode: 2, watchedAt: '2026-09-18T21:00:00Z' },
      { season: 1, episode: 2, watchedAt: '2026-09-18T21:00:00Z' }
    ]
  })
  const plan = planCatchUp([resolved(t)], local(), {}, NOW)
  assert.deepEqual(
    plan.plays.map((p) => [p.season, p.episode]),
    [[1, 2]]
  )
  assert.equal(plan.rejected, 4)
})

check('R3: a show being watched recently is followed, once per id', () => {
  const t = title()
  const twin = title({ ref: 'imdb:tt0000001' })
  const plan = planCatchUp([resolved(t), resolved(twin)], local(), {}, NOW)
  assert.deepEqual(plan.follow, [
    { id: 'tt0000001', type: 'series', title: 'Severance', year: '2022' }
  ])
})

check('R3: no follow when tracked, owed a removal, on hold, stale, or undated', () => {
  const none = (t: SimklLibraryTitle, l: CatchUpLocal = local()): void =>
    assert.deepEqual(planCatchUp([resolved(t)], l, {}, NOW).follow, [])
  none(title(), local({ trackedIds: new Set(['tt0000001']) }))
  none(title(), local({ awaitingRemoval: new Set(['tt0000001']) }))
  none(title({ status: 'hold' }))
  none(title({ status: 'plantowatch' }))
  none(title({ status: 'completed' }))
  none(title({ lastWatchedAt: new Date(NOW.getTime() - FOLLOW_WINDOW_MS - DAY).toISOString() }))
  none(title({ lastWatchedAt: null }))
  none(title({ lastWatchedAt: 'last week' }))
  // Just inside the window still counts.
  assert.equal(
    planCatchUp(
      [
        resolved(
          title({ lastWatchedAt: new Date(NOW.getTime() - FOLLOW_WINDOW_MS + DAY).toISOString() })
        )
      ],
      local(),
      {},
      NOW
    ).follow.length,
    1
  )
})

check('R3: the echo of an episode played here does not follow the show again', () => {
  // Played on this device, pushed to Simkl, then taken off the list here.
  // Simkl's date and count moved, so the title looks changed — but every
  // viewing it holds is one this device already has.
  const t = title({ watchedCount: 2, lastWatchedAt: '2026-09-19T21:00:00Z' })
  const held = local({ watchedKeys: new Set(['tt0000001:1:1', 'tt0000001:1:2']) })
  const stale = { 'simkl:1': '2026-09-18T21:00:00Z|1|watching' }
  const plan = planCatchUp([resolved(t)], held, stale, NOW)
  assert.deepEqual(plan.plays, [])
  assert.deepEqual(plan.follow, [], 'its own echo is not new activity')
  assert.equal(plan.seen['simkl:1'], titleSignature(t), 'but it is recorded as seen')
  // One episode watched somewhere else is.
  const elsewhere = title({
    watchedCount: 3,
    lastWatchedAt: '2026-09-20T09:00:00Z',
    episodes: [...t.episodes, { season: 1, episode: 3, watchedAt: '2026-09-20T09:00:00Z' }]
  })
  const again = planCatchUp([resolved(elsewhere)], held, plan.seen, NOW)
  assert.deepEqual(
    again.plays.map((p) => p.episode),
    [3]
  )
  assert.equal(again.follow.length, 1)
})

check('R3: an anime film, special or music video is never followed', () => {
  for (const animeType of ['movie', 'special', 'music video']) {
    const t = title({ kind: 'anime', ref: 'simkl:50', animeType })
    assert.deepEqual(planCatchUp([resolved(t)], local(), {}, NOW).follow, [], animeType)
  }
  for (const animeType of ['tv', 'ona', 'ova', undefined]) {
    const t = title({ kind: 'anime', ref: 'simkl:50', animeType })
    assert.deepEqual(
      planCatchUp([resolved(t)], local(), {}, NOW).follow,
      [{ id: 'kitsu:100', type: 'anime', title: 'Severance', year: '2022' }],
      String(animeType)
    )
  }
})

check('R3: a film is never followed', () => {
  const t = title({ kind: 'movie', ref: 'simkl:9', status: 'watching', episodes: [] })
  assert.deepEqual(planCatchUp([resolved(t)], local(), {}, NOW).follow, [])
})

check('R4: a planned film taken as watched comes off the plan', () => {
  const t = title({
    kind: 'movie',
    ref: 'simkl:9',
    title: 'Dune',
    year: '2021',
    status: 'completed',
    episodes: []
  })
  const plan = planCatchUp([resolved(t)], local({ trackedIds: new Set(['tt0000002']) }), {}, NOW)
  assert.deepEqual(plan.unplan, [{ id: 'tt0000002', type: 'movie', title: 'Dune', year: '2021' }])
  // Not when it is not planned, and not when the viewing is not new.
  assert.deepEqual(planCatchUp([resolved(t)], local(), {}, NOW).unplan, [])
  assert.deepEqual(
    planCatchUp(
      [resolved(t)],
      local({
        trackedIds: new Set(['tt0000002']),
        watchedKeys: new Set(['tt0000002:movie:movie'])
      }),
      {},
      NOW
    ).unplan,
    [],
    'a film already watched here and planned again is a rewatch plan'
  )
})

check('R4: a tracked show is never un-planned by its plays', () => {
  const plan = planCatchUp(
    [resolved(title())],
    local({ trackedIds: new Set(['tt0000001']) }),
    {},
    NOW
  )
  assert.equal(plan.plays.length, 2)
  assert.deepEqual(plan.unplan, [])
})

check('R5: seen holds every planned title, and only those', () => {
  const changed = title({ ref: 'simkl:1' })
  const same = title({ ref: 'simkl:2' })
  const refused = title({
    ref: 'simkl:3',
    episodes: [{ season: 1, episode: 1, watchedAt: 'never' }]
  })
  const plan = planCatchUp(
    [resolved(changed), resolved(same), resolved(refused)],
    local(),
    { 'simkl:2': titleSignature(same), 'simkl:1': 'old' },
    NOW
  )
  assert.deepEqual(plan.seen, {
    'simkl:1': titleSignature(changed),
    'simkl:3': titleSignature(refused)
  })
})

// ---------------------------------------------------------------------------
console.log('end to end, against a real database')

function ep(season: number, episode: number): Episode {
  return {
    id: `tt0000001:${season}:${episode}`,
    season,
    episode,
    number: episode,
    title: `E${episode}`,
    released: '2020-01-01'
  }
}

check('imported plays and a follow put the show in Continue Watching at the right episode', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-catch-up-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), 'profile-catch-up')
  db.track({ id: 'tt0000002', type: 'movie', title: 'Dune' })

  const show = title()
  const film = title({
    kind: 'movie',
    ref: 'simkl:9',
    title: 'Dune',
    year: '2021',
    status: 'completed',
    lastWatchedAt: '2026-01-02T20:00:00Z',
    watchedCount: null,
    episodes: []
  })
  const titles = [resolved(show), resolved(film)]
  const localNow = (): CatchUpLocal => ({
    watchedKeys: new Set(
      db.history().map((h) => `${h.id}:${h.season ?? 'movie'}:${h.episode ?? 'movie'}`)
    ),
    trackedIds: new Set(db.tracked().map((t) => t.id)),
    awaitingRemoval: new Set()
  })

  const first = planCatchUp(titles, localNow(), {}, NOW)
  assert.equal(first.plays.length, 3)
  assert.equal(db.importWatched(first.plays), 3)
  for (const f of first.follow) db.track(f)
  for (const u of first.unplan) db.untrack(u.id)

  assert.equal(db.isTracked('tt0000001'), true, 'the show is followed')
  assert.equal(db.isTracked('tt0000002'), false, 'the film came off the plan')

  const detail = {
    id: 'tt0000001',
    title: 'Severance',
    type: 'series',
    poster: '',
    background: '',
    logo: '',
    year: '2022',
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    trailers: [],
    videos: [ep(1, 1), ep(1, 2), ep(1, 3), ep(2, 1)]
  } as CatalogItem
  const rows = continueWatchingList([detail], db.history())
  assert.equal(rows.length, 1)
  assert.equal(rows[0].continueSeason, 1)
  assert.equal(rows[0].continueEpisode, 3)
  assert.equal(rows[0].watchedCount, 2)

  // The second pass over the same library, with the state the first one
  // left behind: nothing at all.
  const seen = { ...first.seen }
  const second = planCatchUp(titles, localNow(), seen, NOW)
  assert.deepEqual(second, { plays: [], follow: [], unplan: [], seen: {}, rejected: 0 })

  // Even with `seen` lost, the local rows alone stop a duplicate: no plays,
  // no second follow.
  const forgetful = planCatchUp(titles, localNow(), {}, NOW)
  assert.deepEqual(forgetful.plays, [])
  assert.deepEqual(forgetful.follow, [])

  // And importing the same plan twice adds nothing.
  assert.equal(db.importWatched(first.plays), 0)
  assert.equal(db.history().length, 3)
})

// ---------------------------------------------------------------------------
// The pass itself (simklCatchUp.ts), with every service faked and a real
// database underneath. What is pinned here is what a request costs: Simkl
// suspends clients that fetch whole libraries without asking first, so the
// number of calls a pass makes is as much the behaviour as what it writes.

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

const PASS_PROFILE = 'profile-catch-up-pass'
const MINUTE = 60 * 1000

function libraryPayloads(): Record<SimklLibraryKind, unknown> {
  return {
    movie: {
      movies: [
        {
          movie: { title: 'Dune', year: 2021, ids: { simkl: 9, imdb: 'tt0000002' } },
          status: 'completed',
          last_watched_at: '2026-01-02T20:00:00Z'
        }
      ]
    },
    show: {
      shows: [
        {
          show: { title: 'Severance', year: 2022, ids: { simkl: 1, imdb: 'tt0000001' } },
          status: 'watching',
          last_watched_at: '2026-09-19T21:00:00Z',
          watched_episodes_count: 2,
          seasons: [
            {
              number: 1,
              episodes: [
                { number: 1, watched_at: '2026-09-18T21:00:00Z' },
                { number: 2, watched_at: '2026-09-19T21:00:00Z' }
              ]
            }
          ]
        }
      ]
    },
    anime: {
      anime: [
        {
          // A MAL id and no Kitsu one: resolved through the bridge.
          show: { title: 'Frieren', year: 2023, ids: { simkl: 50, mal: 52991 } },
          anime_type: 'tv',
          status: 'watching',
          last_watched_at: '2026-09-19T20:00:00Z',
          watched_episodes_count: 1,
          seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-09-19T20:00:00Z' }] }]
        }
      ]
    }
  }
}

interface Harness {
  db: ReturnType<typeof createDatabase>
  deps: CatchUpDeps
  memory: CatchUpMemory
  calls: string[]
  stamps: { movies: string | null; shows: string | null; anime: string | null }
  account: string
  clock: number
  ready: boolean
  busy: boolean
  activitiesError: (Error & { status?: number }) | null
  failing: Set<SimklLibraryKind>
  libraries: Record<SimklLibraryKind, unknown>
  lookup: { kitsuId: number | null; answered: boolean }
  /** Runs inside library(kind), before it answers — a profile switch, say. */
  during: Partial<Record<SimklLibraryKind, () => void>>
  /** The `since` each library call was made with, newest last. */
  since: Array<[SimklLibraryKind, string | null]>
  /** Trakt's account mark; empty is not connected. */
  trakt: string
  /** What the pass has written about its own progress. */
  state(): CatchUpState | null
}

function harness(): Harness {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-catch-up-pass-'))
  const db = createDatabase(path.join(dir, 'test.sqlite'), PASS_PROFILE)
  // On the plan here, and completed at Simkl: rule 8 takes it off.
  db.track({ id: 'tt0000002', type: 'movie', title: 'Dune' })
  const h: Harness = {
    db,
    memory: newCatchUpMemory(),
    calls: [],
    stamps: { movies: 'm1', shows: 's1', anime: 'a1' },
    account: 'acct-1',
    clock: NOW.getTime(),
    ready: true,
    busy: false,
    activitiesError: null,
    failing: new Set(),
    libraries: libraryPayloads(),
    lookup: { kitsuId: 46474, answered: true },
    during: {},
    since: [],
    trakt: '',
    state: () =>
      db.getCache<CatchUpState>(`simkl:catch-up:v1:${PASS_PROFILE}`, { allowExpired: true }),
    deps: undefined as unknown as CatchUpDeps
  }
  h.deps = {
    db,
    account: () => h.account,
    connected: () => ({ simkl: h.account, trakt: h.trakt, mal: '' }),
    activities: async () => {
      h.calls.push('activities')
      if (h.activitiesError) throw h.activitiesError
      return {
        all: 'x',
        movies: { all: h.stamps.movies },
        tv_shows: { all: h.stamps.shows },
        anime: { all: h.stamps.anime }
      }
    },
    library: async (kind, since) => {
      h.calls.push(`library:${kind}`)
      h.since.push([kind, since])
      h.during[kind]?.()
      if (h.failing.has(kind)) throw new Error(`${kind} timed out`)
      return h.libraries[kind]
    },
    syncPlanned: async () => {
      h.calls.push('planned')
      return { added: 0, removed: 0 }
    },
    awaitingRemoval: () => new Set(),
    lookupKitsu: async (service, value) => {
      h.calls.push(`lookup:${service}:${value}`)
      return h.lookup
    },
    animeTarget: (kitsuId) => ({ id: `kitsu:${kitsuId}`, season: 1 }),
    animeReady: () => h.ready,
    unplanWatched: async (item) => {
      h.calls.push(`unplan:${item.id}`)
    },
    announce: () => {
      h.calls.push('announce')
    },
    artwork: () => {},
    busy: () => h.busy,
    now: () => h.clock,
    log: () => {}
  }
  return h
}

/** The calls one pass made, with the log cleared for the next. */
async function passOf(
  h: Harness,
  options: { force?: boolean } = {}
): Promise<{ report: CatchUpReport; calls: string[] }> {
  h.calls.length = 0
  const report = await runCatchUp(h.deps, h.memory, options)
  return { report, calls: [...h.calls] }
}

function libraryCalls(calls: string[]): string[] {
  return calls.filter((call) => call.startsWith('library:'))
}

async function passes(): Promise<void> {
  console.log('runCatchUp')

  await checkAsync(
    'a first pass imports, follows and takes a watched film off the plan',
    async () => {
      const h = harness()
      const { report, calls } = await passOf(h)
      assert.deepEqual(calls, [
        'activities',
        'planned',
        'library:movie',
        'unplan:tt0000002',
        'library:show',
        'library:anime',
        'lookup:mal:52991',
        'announce'
      ])
      assert.equal(report.connected, true)
      assert.equal(report.changed, true)
      assert.equal(report.plays, 4, 'one film, two episodes, one anime episode')
      assert.equal(report.followed, 2)
      assert.equal(report.deferred, false)
      assert.equal(report.at, h.clock)
      assert.equal(h.db.isTracked('tt0000001'), true, 'the show being watched is followed')
      assert.equal(h.db.isTracked('kitsu:46474'), true, 'and so is the anime')
      assert.equal(h.db.isTracked('tt0000002'), false, 'the film came off the plan')
      assert.deepEqual(h.state()?.stamps, { movies: 'm1', shows: 's1', anime: 'a1' })
      assert.deepEqual(Object.keys(h.state()?.seen ?? {}).sort(), [
        'simkl:1',
        'simkl:50',
        'simkl:9'
      ])
    }
  )

  await checkAsync('nothing moved at Simkl: exactly one request, and nothing written', async () => {
    const h = harness()
    await passOf(h)
    const before = h.db.history().length
    h.clock += 3 * MINUTE
    const { report, calls } = await passOf(h)
    assert.deepEqual(calls, ['activities'])
    assert.equal(report.changed, false)
    assert.equal(report.plays, 0)
    assert.equal(h.db.history().length, before)
  })

  await checkAsync('a moved tv_shows stamp fetches shows and nothing else', async () => {
    const h = harness()
    await passOf(h)
    h.clock += 3 * MINUTE
    h.stamps.shows = 's2'
    const shows = h.libraries.show as { shows: Array<Record<string, unknown>> }
    shows.shows[0].watched_episodes_count = 3
    shows.shows[0].last_watched_at = '2026-09-20T09:00:00Z'
    ;(shows.shows[0].seasons as Array<{ episodes: unknown[] }>)[0].episodes.push({
      number: 3,
      watched_at: '2026-09-20T09:00:00Z'
    })
    const { report, calls } = await passOf(h)
    assert.deepEqual(libraryCalls(calls), ['library:show'])
    assert.equal(report.plays, 1, 'only the new episode')
    assert.equal(report.followed, 0, 'already followed')
    assert.equal(h.state()?.stamps.shows, 's2')
  })

  await checkAsync('activities refused: signed out, and Simkl is not asked again', async () => {
    const h = harness()
    h.activitiesError = Object.assign(new Error('Unauthorized'), { status: 401 })
    const first = await passOf(h)
    assert.equal(first.report.signedOut, true)
    assert.deepEqual(first.calls, ['activities'])
    assert.equal(h.state(), null, 'no state written')
    h.clock += 3 * MINUTE
    const second = await passOf(h)
    assert.deepEqual(second.calls, [], 'no call until the account changes')
    assert.equal(second.report.signedOut, true)
    // Linking again is a new account mark: asked again at once.
    h.activitiesError = null
    h.account = 'acct-2'
    const third = await passOf(h)
    assert.equal(third.calls[0], 'activities')
    assert.equal(third.report.signedOut, undefined)
  })

  await checkAsync(
    'activities failing otherwise: no library fetch, no state, backs off',
    async () => {
      const h = harness()
      h.activitiesError = Object.assign(new Error('Too many requests'), { status: 429 })
      const first = await passOf(h)
      assert.deepEqual(first.calls, ['activities'])
      assert.equal(first.report.error, 'Too many requests')
      assert.equal(h.state(), null)
      h.clock += 3 * MINUTE
      assert.deepEqual((await passOf(h)).calls, [], 'inside the five-minute backoff')
      h.clock += 3 * MINUTE
      h.activitiesError = null
      assert.equal((await passOf(h)).calls[0], 'activities', 'after it')
    }
  )

  await checkAsync(
    'one kind failing still commits the others, and keeps its own stamp',
    async () => {
      const h = harness()
      h.failing.add('show')
      const first = await passOf(h)
      assert.deepEqual(libraryCalls(first.calls), [
        'library:movie',
        'library:show',
        'library:anime'
      ])
      assert.equal(first.report.error, 'show timed out')
      assert.deepEqual(h.state()?.stamps, { movies: 'm1', shows: null, anime: 'a1' })
      assert.equal(h.db.isTracked('kitsu:46474'), true, 'the kind after the failure still landed')
      assert.equal(h.db.isTracked('tt0000001'), false)
      // Due again, but inside its own backoff: not fetched.
      h.failing.clear()
      h.clock += 3 * MINUTE
      assert.deepEqual(libraryCalls((await passOf(h)).calls), [])
      // After the backoff, fetched and applied.
      h.clock += 30 * MINUTE
      const later = await passOf(h)
      assert.deepEqual(libraryCalls(later.calls), ['library:show'])
      assert.equal(later.report.plays, 2)
      assert.equal(h.state()?.stamps.shows, 's1')
    }
  )

  await checkAsync('an anime lookup nobody answered leaves the anime stamp alone', async () => {
    const h = harness()
    h.lookup = { kitsuId: null, answered: false }
    const first = await passOf(h)
    assert.equal(h.state()?.stamps.anime, null, 'fetched again next time')
    assert.equal(h.state()?.seen['simkl:50'], undefined, 'and the title is not recorded')
    assert.equal(first.report.skipped, 0)
    assert.equal(h.db.isTracked('kitsu:46474'), false)
    h.lookup = { kitsuId: 46474, answered: true }
    // Due again at once (its stamp never moved), but not fetched on the very
    // next resume: what held it up takes minutes to clear.
    h.clock += 3 * MINUTE
    assert.deepEqual(libraryCalls((await passOf(h)).calls), [])
    h.clock += 10 * MINUTE
    const second = await passOf(h)
    assert.deepEqual(libraryCalls(second.calls), ['library:anime'])
    assert.equal(h.state()?.stamps.anime, 'a1')
    assert.equal(h.db.isTracked('kitsu:46474'), true)
  })

  await checkAsync('an answered "no Kitsu id" is skipped, and the stamp moves on', async () => {
    const h = harness()
    h.lookup = { kitsuId: null, answered: true }
    const { report } = await passOf(h)
    assert.equal(report.skipped, 1)
    assert.equal(h.state()?.stamps.anime, 'a1')
  })

  await checkAsync('anime is deferred until the catalog is grouped', async () => {
    const h = harness()
    h.ready = false
    const first = await passOf(h)
    assert.equal(first.report.deferred, true)
    assert.deepEqual(libraryCalls(first.calls), ['library:movie', 'library:show'])
    assert.deepEqual(h.state()?.stamps, { movies: 'm1', shows: 's1', anime: null })
    h.ready = true
    h.clock += 3 * MINUTE
    const second = await passOf(h)
    assert.equal(second.report.deferred, false)
    assert.deepEqual(libraryCalls(second.calls), ['library:anime'])
    assert.equal(h.state()?.stamps.anime, 'a1')
  })

  await checkAsync('a profile switch mid-pass: nothing is written after it, anywhere', async () => {
    const h = harness()
    h.during.show = () => h.db.setActiveProfile('someone-else')
    const { report, calls } = await passOf(h)
    assert.deepEqual(libraryCalls(calls), ['library:movie', 'library:show'])
    assert.equal(report.plays, 1, 'the film, written before the switch')
    // Nothing landed on the profile that became active…
    assert.deepEqual(h.db.history(), [])
    assert.deepEqual(h.db.tracked(), [])
    assert.equal(h.db.getCache(`simkl:catch-up:v1:someone-else`, { allowExpired: true }), null)
    // …and nothing more on the one the pass was for.
    h.db.setActiveProfile(PASS_PROFILE)
    assert.deepEqual(
      h.db.history().map((row) => row.id),
      ['tt0000002']
    )
    assert.equal(h.db.isTracked('tt0000001'), false)
    assert.deepEqual(h.state()?.stamps, { movies: 'm1', shows: null, anime: null })
  })

  await checkAsync('an account switch mid-pass stops it the same way', async () => {
    const h = harness()
    h.during.movie = () => {
      h.account = 'acct-2'
    }
    const { report } = await passOf(h)
    assert.equal(report.plays, 0)
    assert.deepEqual(h.db.history(), [])
    assert.equal(h.state(), null)
  })

  await checkAsync('the two-minute floor, force, and a changed account', async () => {
    const h = harness()
    const first = await passOf(h)
    h.clock += MINUTE
    const floored = await passOf(h)
    assert.deepEqual(floored.calls, [])
    assert.equal(floored.report, first.report, 'the same report, so `at` says it is not new')
    const forced = await passOf(h, { force: true })
    assert.deepEqual(forced.calls, ['activities'])
    assert.notEqual(forced.report.at, first.report.at)
    h.clock += 10 * 1000
    h.account = 'acct-2'
    assert.equal((await passOf(h)).calls[0], 'activities', 'pairing is never floored')
  })

  await checkAsync('single flight: a second call shares the running pass', async () => {
    const h = harness()
    h.calls.length = 0
    const a = runCatchUp(h.deps, h.memory)
    const b = runCatchUp(h.deps, h.memory, { force: true })
    assert.equal(a, b)
    const [ra, rb] = await Promise.all([a, b])
    assert.equal(ra, rb)
    assert.equal(h.calls.filter((call) => call === 'activities').length, 1)
  })

  await checkAsync('while something is playing, the last report and no requests', async () => {
    const h = harness()
    h.busy = true
    const idle = await passOf(h)
    assert.deepEqual(idle.calls, [])
    assert.equal(idle.report.at, 0)
    h.busy = false
    const ran = await passOf(h)
    h.busy = true
    h.clock += 10 * MINUTE
    const again = await passOf(h, { force: true })
    assert.deepEqual(again.calls, [])
    assert.equal(again.report, ran.report)
  })

  await checkAsync(
    'the anime catalog un-grouped during the pass: nothing anime is written',
    async () => {
      const h = harness()
      // Ready when the pass asks, gone by the time the library has answered:
      // a catalog re-crawl landed in between.
      h.during.anime = () => {
        h.ready = false
      }
      const { report } = await passOf(h)
      assert.equal(report.deferred, true)
      assert.equal(h.db.isTracked('kitsu:46474'), false)
      assert.deepEqual(
        h.db.history().filter((row) => String(row.id).startsWith('kitsu:')),
        []
      )
      assert.equal(h.state()?.stamps.anime, null, 'so the stamp stays put')
      assert.equal('simkl:50' in (h.state()?.seen ?? {}), false, 'and the title is not seen')
      // Films and shows were not held up by it.
      assert.equal(h.db.isTracked('tt0000001'), true)
      // Grouped again: the next pass takes it.
      h.ready = true
      h.during.anime = undefined
      h.clock += 11 * MINUTE
      const next = await passOf(h)
      assert.deepEqual(libraryCalls(next.calls), ['library:anime'])
      assert.equal(h.db.isTracked('kitsu:46474'), true)
      assert.equal(h.state()?.stamps.anime, 'a1')
    }
  )

  await checkAsync(
    'a film comes off the plan before any wait, whatever the wait brings',
    async () => {
      const h = harness()
      h.db.track({ id: 'tt0000007', type: 'movie', title: 'Arrival' })
      ;(h.libraries.movie as { movies: unknown[] }).movies.push({
        movie: { title: 'Arrival', year: 2016, ids: { simkl: 11, imdb: 'tt0000007' } },
        status: 'completed',
        last_watched_at: '2026-01-03T20:00:00Z'
      })
      // The first push to the services is where somebody links another account.
      const push = h.deps.unplanWatched
      h.deps.unplanWatched = async (item) => {
        await push(item)
        h.account = 'acct-2'
      }
      const { calls } = await passOf(h)
      assert.equal(
        calls.filter((call) => call.startsWith('unplan:')).length,
        1,
        'one push went out'
      )
      assert.equal(h.db.isTracked('tt0000002'), false)
      assert.equal(h.db.isTracked('tt0000007'), false, 'the second film left the plan all the same')
      assert.equal(calls.includes('announce'), true)
    }
  )

  await checkAsync(
    'a state write that fails does not lose the pass or its announcement',
    async () => {
      const h = harness()
      const putCache = h.db.putCache.bind(h.db)
      let failed = 0
      h.db.putCache = ((key: string, ...rest: unknown[]) => {
        if (key.startsWith('simkl:catch-up:') && failed === 0) {
          failed++
          throw new Error('disk full')
        }
        return (putCache as (...args: unknown[]) => void)(key, ...rest)
      }) as typeof h.db.putCache
      const { report, calls } = await passOf(h)
      assert.equal(failed, 1)
      assert.equal(report.error, 'disk full')
      assert.equal(h.db.isTracked('tt0000002'), false, 'the film still left the plan')
      assert.equal(calls.includes('announce'), true, 'and what landed was announced')
      // The other kinds were not taken down with it.
      assert.equal(h.db.isTracked('tt0000001'), true)
    }
  )

  await checkAsync('a backoff earned by one account does not hold up the next', async () => {
    const h = harness()
    h.activitiesError = Object.assign(new Error('Simkl is down'), { status: 503 })
    await passOf(h)
    h.clock += 10 * 1000
    // Still inside the backoff for the same account, even forced.
    assert.deepEqual((await passOf(h, { force: true })).calls, [])
    // Linked again: a new token, so a new account mark.
    h.activitiesError = null
    h.account = 'acct-2'
    const { report, calls } = await passOf(h, { force: true })
    assert.equal(calls[0], 'activities')
    assert.equal(report.plays, 4)
  })

  await checkAsync('a kind is fetched whole once, then only what changed since', async () => {
    const h = harness()
    await passOf(h)
    assert.deepEqual(
      h.since,
      [
        ['movie', null],
        ['show', null],
        ['anime', null]
      ],
      'a first pass reads every kind whole'
    )
    h.since.length = 0
    h.clock += 3 * MINUTE
    h.stamps.shows = 's2'
    await passOf(h)
    assert.deepEqual(h.since, [['show', 's1']], 'from the stamp the last fetch was made under')
    h.since.length = 0
    h.clock += 3 * MINUTE
    h.stamps.shows = 's3'
    await passOf(h)
    assert.deepEqual(h.since, [['show', 's2']], 'which moves on with each fetch applied')
    // A week after the whole fetch, the next one due is whole again.
    h.since.length = 0
    h.clock += 7 * 24 * 60 * MINUTE
    h.stamps.shows = 's4'
    await passOf(h)
    assert.deepEqual(h.since, [['show', null]])
    h.since.length = 0
    h.clock += 3 * MINUTE
    h.stamps.shows = 's5'
    await passOf(h)
    assert.deepEqual(h.since, [['show', 's4']], 'and incremental after it')
  })

  await checkAsync(
    'a kind that was not applied in full is asked for from the same stamp',
    async () => {
      const h = harness()
      await passOf(h)
      h.clock += 3 * MINUTE
      h.stamps.anime = 'a2'
      h.lookup = { kitsuId: null, answered: false }
      const anime = h.libraries.anime as { anime: Array<Record<string, unknown>> }
      anime.anime.push({
        show: { title: 'Dandadan', year: 2024, ids: { simkl: 51, mal: 57334 } },
        anime_type: 'tv',
        status: 'watching',
        last_watched_at: '2026-09-20T09:00:00Z',
        watched_episodes_count: 1,
        seasons: [{ number: 1, episodes: [{ number: 1, watched_at: '2026-09-20T09:00:00Z' }] }]
      })
      h.since.length = 0
      await passOf(h)
      assert.deepEqual(h.since, [['anime', 'a1']])
      assert.equal(h.state()?.stamps.anime, 'a1', 'not advanced: a lookup went unanswered')
      h.since.length = 0
      h.clock += 11 * MINUTE
      h.lookup = { kitsuId: 99, answered: true }
      await passOf(h)
      assert.deepEqual(h.since, [['anime', 'a1']], 'so the same changes are asked for again')
      assert.equal(h.state()?.stamps.anime, 'a2')
      assert.equal(h.db.isTracked('kitsu:99'), true)
    }
  )

  await checkAsync('a fresh link pulls the watchlists at once, whatever the interval', async () => {
    // Trakt only: nothing at Simkl to say a list moved, so the pull is on its
    // own ten-minute timer — which a newly linked account must not wait out.
    const h = harness()
    h.account = ''
    h.trakt = 'trakt-1'
    assert.deepEqual((await passOf(h)).calls, ['planned'], 'the first pass pulls')
    h.clock += 3 * MINUTE
    assert.deepEqual((await passOf(h)).calls, [], 'inside the interval: not again')
    h.clock += MINUTE
    h.trakt = 'trakt-2'
    assert.deepEqual((await passOf(h)).calls, ['planned'], 'another account: at once')
    h.clock += MINUTE
    assert.deepEqual((await passOf(h, { force: true })).calls, ['planned'], 'and when forced')
  })

  await checkAsync('the floor and a running pass are per profile', async () => {
    const h = harness()
    const first = await passOf(h)
    h.clock += 10 * 1000
    // Another profile inside the two minutes: its own pass, not this report.
    h.db.setActiveProfile('someone-else')
    const other = await passOf(h)
    assert.equal(other.calls[0], 'activities')
    assert.notEqual(other.report, first.report)
    assert.equal(h.db.history().length, 4, 'and its own library')
    // Back again, still inside the floor of the pass that was for it? No:
    // the last pass was for the other profile, so this one runs.
    h.clock += 10 * 1000
    h.db.setActiveProfile(PASS_PROFILE)
    assert.equal((await passOf(h)).calls[0], 'activities')
    // A call made while a pass for another profile is running waits for it
    // and then runs its own.
    h.clock += 3 * MINUTE
    h.calls.length = 0
    const running = runCatchUp(h.deps, h.memory, { force: true })
    h.db.setActiveProfile('someone-else')
    const queued = runCatchUp(h.deps, h.memory, { force: true })
    assert.notEqual(queued, running)
    const [a, b] = await Promise.all([running, queued])
    assert.notEqual(a, b, 'two reports, one per profile')
    assert.equal(h.calls.filter((call) => call === 'activities').length, 2)
  })

  await checkAsync('nothing connected: a report that says so, and no requests', async () => {
    const h = harness()
    h.account = ''
    const { report, calls } = await passOf(h)
    assert.deepEqual(calls, [])
    assert.equal(report.connected, false)
    assert.equal(report.changed, false)
  })

  console.log('fillTrackedArtwork')

  await checkAsync('fills bare rows once, under their own id, and never re-plans one', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-catch-up-art-'))
    const db = createDatabase(path.join(dir, 'test.sqlite'), PASS_PROFILE)
    db.track({ id: 'tt0000001', type: 'series', title: 'Severance' })
    db.track({ id: 'tt0000003', type: 'series', title: 'Gone' })
    db.track({ id: 'tt0000004', type: 'movie', title: 'Has one', poster: 'https://p/4.jpg' })
    const asked: string[] = []
    let announced = 0
    const tried = new Set<string>()
    const deps = {
      db,
      metadata: async (_type: MediaKind, id: string) => {
        asked.push(id)
        // Taken off the list while its artwork was loading.
        if (id === 'tt0000003') db.untrack(id)
        return {
          id: `${id}-canonical`,
          type: 'series',
          title: 'X',
          poster: `https://p/${id}.jpg`
        } as CatalogItem
      },
      announce: () => {
        announced++
      },
      tried,
      failures: new Map<string, number>()
    }
    assert.equal(await fillTrackedArtwork(PASS_PROFILE, deps), 1)
    assert.deepEqual(asked.sort(), ['tt0000001', 'tt0000003'])
    assert.equal(announced, 1)
    const row = db.tracked().find((item) => item.id === 'tt0000001')
    assert.equal(row?.poster, 'https://p/tt0000001.jpg')
    assert.equal(db.isTracked('tt0000001-canonical'), false, 'the row did not move')
    assert.equal(db.isTracked('tt0000003'), false, 'and an untracked one was not put back')
    asked.length = 0
    assert.equal(await fillTrackedArtwork(PASS_PROFILE, deps), 0)
    assert.deepEqual(asked, [], 'nothing is tried twice in one process')
    // A row that WOULD be filled, so the profile is the only thing stopping it.
    db.track({ id: 'tt0000005', type: 'series', title: 'Bare' })
    assert.equal(await fillTrackedArtwork('another-profile', deps), 0)
    assert.deepEqual(asked, [], 'another profile’s pass asks for nothing')
    assert.equal(db.tracked().find((item) => item.id === 'tt0000005')?.poster, '')
  })

  await checkAsync(
    'a lookup that failed is asked again, and given up on the third time',
    async () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-catch-up-art-'))
      const db = createDatabase(path.join(dir, 'test.sqlite'), PASS_PROFILE)
      db.track({ id: 'tt0000001', type: 'series', title: 'Severance' })
      db.track({ id: 'tt0000009', type: 'movie', title: 'Nobody knows it' })
      const asked: string[] = []
      let offline = true
      const deps = {
        db,
        metadata: async (_type: MediaKind, id: string) => {
          asked.push(id)
          // One title no source can resolve; the other fails only while offline.
          if (id === 'tt0000009' || offline) throw new Error('fetch failed')
          return { id, type: 'series', title: 'X', poster: 'https://p/x.jpg' } as CatalogItem
        },
        announce: () => {},
        tried: new Set<string>(),
        failures: new Map<string, number>()
      }
      assert.equal(await fillTrackedArtwork(PASS_PROFILE, deps), 0)
      assert.deepEqual(asked.sort(), ['tt0000001', 'tt0000009'])
      // Back online: the one the network cost its poster is asked again.
      offline = false
      asked.length = 0
      assert.equal(await fillTrackedArtwork(PASS_PROFILE, deps), 1)
      assert.deepEqual(asked.sort(), ['tt0000001', 'tt0000009'])
      assert.equal(db.tracked().find((item) => item.id === 'tt0000001')?.poster, 'https://p/x.jpg')
      // The other fails a third time, and is then left alone.
      asked.length = 0
      await fillTrackedArtwork(PASS_PROFILE, deps)
      assert.deepEqual(asked, ['tt0000009'])
      asked.length = 0
      await fillTrackedArtwork(PASS_PROFILE, deps)
      assert.deepEqual(asked, [], 'a title that fails every time is not asked for on every resume')
    }
  )

  await checkAsync('a profile switch while artwork loads writes nothing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-simkl-catch-up-art-'))
    const db = createDatabase(path.join(dir, 'test.sqlite'), PASS_PROFILE)
    db.track({ id: 'tt0000001', type: 'series', title: 'Severance' })
    let announced = 0
    const filled = await fillTrackedArtwork(PASS_PROFILE, {
      db,
      metadata: async (_type: MediaKind, id: string) => {
        db.setActiveProfile('someone-else')
        return { id, type: 'series', title: 'X', poster: 'https://p/x.jpg' } as CatalogItem
      },
      announce: () => {
        announced++
      },
      tried: new Set<string>(),
      failures: new Map<string, number>()
    })
    assert.equal(filled, 0)
    assert.equal(announced, 0)
    assert.deepEqual(db.tracked(), [], 'nothing landed on the profile that became active')
    db.setActiveProfile(PASS_PROFILE)
    assert.equal(db.tracked()[0]?.poster, '', 'and the row it was for is untouched')
  })
}

void passes().then(() => console.log(`\n${pass} passed`))
