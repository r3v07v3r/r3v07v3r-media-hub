import assert from 'node:assert/strict'
import { computeWantedList } from '../src/shared/lancache/wantedList'
import type { HistoryEntry, TrackedItem } from '../src/shared/media-hub/types'

// The wanted list is where the three prefetch triggers become concrete
// contentKeys. The keys must match cacheContentKey's shape exactly, and
// anime must keep its no-season addressing — a mismatch on either doesn't
// error, it just makes the daemon invisibly never used for that title.

const trackedItem = (overrides: Partial<TrackedItem>): TrackedItem => ({
  id: 'tt0',
  simklId: null,
  type: 'movie',
  title: 'T',
  poster: '',
  background: '',
  logo: '',
  year: '',
  genres: [],
  description: '',
  rating: '',
  runtime: '',
  trailers: [],
  ...overrides
})

const historyEntry = (overrides: Partial<HistoryEntry>): HistoryEntry => ({
  id: 'tt0',
  type: 'series',
  season: null,
  episode: null,
  watchedAt: '2026-08-01T00:00:00Z',
  title: 'T',
  ...overrides
})

// A tracked movie is wanted as itself.
{
  const wanted = computeWantedList([trackedItem({ id: 'tt100', title: 'Film' })], [])
  assert.equal(wanted.length, 1)
  assert.equal(wanted[0].contentKey, 'tt100::', 'movie key matches cacheContentKey shape')
  assert.equal(wanted[0].resolveId, 'tt100')
  assert.equal(wanted[0].type, 'movie')
}

// A series mid-watch wants the NEXT episodes, addressed id:season:episode.
{
  const wanted = computeWantedList(
    [trackedItem({ id: 'tt200', type: 'series', title: 'Show' })],
    [historyEntry({ id: 'tt200', season: 2, episode: 5, title: 'Show' })]
  )
  const keys = wanted.map((entry) => entry.contentKey)
  assert.ok(keys.includes('tt200:2:6'), 'episode after the last watched one')
  assert.ok(keys.includes('tt200:2:7'), 'and the one after that')
  assert.ok(!keys.includes('tt200:2:5'), 'the already-watched episode is not wanted')
  const first = wanted.find((entry) => entry.contentKey === 'tt200:2:6')
  assert.equal(first?.resolveId, 'tt200:2:6', 'resolve id matches the app addressing')
}

// A never-started tracked series begins at episode 1.
{
  const wanted = computeWantedList([trackedItem({ id: 'tt300', type: 'series' })], [])
  assert.ok(
    wanted.some((entry) => entry.contentKey === 'tt300:1:1'),
    'a fresh series starts at S01E01'
  )
}

// Anime keeps its no-season addressing: kitsuId:episode as the resolve id,
// and an empty season segment in the content key — the same special case
// startPlayback and the local-cache tier already handle.
{
  const wanted = computeWantedList(
    [trackedItem({ id: 'kitsu:555', type: 'anime', title: 'Anime' })],
    [historyEntry({ id: 'kitsu:555', type: 'anime', season: null, episode: 8, title: 'Anime' })]
  )
  const next = wanted.find((entry) => entry.contentKey === 'kitsu:555::9')
  assert.ok(next, 'anime key has an empty season segment')
  assert.equal(next?.resolveId, 'kitsu:555:9', 'anime resolve id is kitsuId:episode')
}

// Duplicates collapse: the same next-episode reachable via recent history
// AND the watchlist appears once.
{
  const wanted = computeWantedList(
    [trackedItem({ id: 'tt400', type: 'series', title: 'Show' })],
    [historyEntry({ id: 'tt400', season: 1, episode: 3, title: 'Show' })]
  )
  const occurrences = wanted.filter((entry) => entry.contentKey === 'tt400:1:4')
  assert.equal(occurrences.length, 1, 'one wanted entry per contentKey')
}

// The list is bounded — a huge watchlist cannot flood the daemon.
{
  const many = Array.from({ length: 100 }, (_, index) =>
    trackedItem({ id: `tt${5000 + index}`, title: `Film ${index}` })
  )
  const wanted = computeWantedList(many, [])
  assert.ok(wanted.length <= 30, `bounded (got ${wanted.length})`)
}

console.log('ok  lancache feeder wanted list')
