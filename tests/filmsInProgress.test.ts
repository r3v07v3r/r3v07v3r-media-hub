// Films in Continue Watching: a film is in the row while it has a resume
// bookmark and no watched mark written since. Real bookmarks in a real temp
// SQLite file (database.ts's filmsInProgress), then the pure row builders in
// core.ts that home:personalized feeds them through.
//
// Run with: npx tsx tests/filmsInProgress.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { createDatabase } from '../src/main/media-hub/database'
import {
  continueWatchingList,
  filmContinueWatchingRows,
  mergeContinueWatching
} from '../src/main/media-hub/core'
import type { CatalogItem, ContinueWatchingEntry } from '../src/shared/media-hub/types'

const TEST_PROFILE = 'profile-test'

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

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-films-progress-test-'))
  return path.join(dir, 'test.sqlite')
}

function film(id: string, title = id): CatalogItem {
  return { id, type: 'movie', title, genres: [] } as unknown as CatalogItem
}

console.log('filmsInProgress — the database read')

check('a film part way through is in progress, with its bookmark', () => {
  const db = createDatabase(tempDbPath(), TEST_PROFILE)
  db.savePlaybackPosition('tt1', undefined, 1500, 6000)
  const rows = db.filmsInProgress()
  assert.equal(rows.length, 1)
  assert.equal(rows[0].contentId, 'tt1')
  assert.equal(rows[0].positionSeconds, 1500)
  assert.equal(rows[0].durationSeconds, 6000)
  db.close()
})

check('a film past 90% or under 20 seconds is not (no bookmark is kept)', () => {
  const db = createDatabase(tempDbPath(), TEST_PROFILE)
  db.savePlaybackPosition('tt1', undefined, 5500, 6000)
  db.savePlaybackPosition('tt2', undefined, 10, 6000)
  assert.deepEqual(db.filmsInProgress(), [])
  db.close()
})

check('an episode bookmark is never a film in progress', () => {
  const db = createDatabase(tempDbPath(), TEST_PROFILE)
  db.savePlaybackPosition('tt-show', { season: 1, episode: 2 }, 600, 2400)
  assert.deepEqual(db.filmsInProgress(), [])
  db.close()
})

check('marking the film watched takes it out', () => {
  const db = createDatabase(tempDbPath(), TEST_PROFILE)
  db.savePlaybackPosition('tt1', undefined, 1500, 6000)
  db.markWatched({ id: 'tt1', type: 'movie', title: 'One' })
  assert.deepEqual(db.filmsInProgress(), [])
  db.close()
})

check('a rewatch started after an old watched mark is in progress again', () => {
  const file = tempDbPath()
  const db = createDatabase(file, TEST_PROFILE)
  db.markWatched({ id: 'tt1', type: 'movie', title: 'One' })
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec(`UPDATE watch_history SET watched_at='2020-01-01T00:00:00.000Z' WHERE content_id='tt1'`)
  raw.close()
  const again = createDatabase(file, TEST_PROFILE)
  again.savePlaybackPosition('tt1', undefined, 1500, 6000)
  assert.deepEqual(
    again.filmsInProgress().map((row) => row.contentId),
    ['tt1']
  )
  again.close()
})

check('clearing the bookmark (Remove saves position 0) takes it out', () => {
  const db = createDatabase(tempDbPath(), TEST_PROFILE)
  db.savePlaybackPosition('tt1', undefined, 1500, 6000)
  db.savePlaybackPosition('tt1', undefined, 0)
  assert.deepEqual(db.filmsInProgress(), [])
  db.close()
})

check('newest bookmark first, and another profile’s films are not listed', () => {
  const file = tempDbPath()
  const db = createDatabase(file, TEST_PROFILE)
  db.savePlaybackPosition('tt-old', undefined, 900, 6000)
  db.savePlaybackPosition('tt-new', undefined, 900, 6000)
  db.close()
  const raw = new DatabaseSync(file)
  raw.exec(
    `UPDATE playback_positions SET updated_at='2026-01-01T00:00:00.000Z' WHERE content_id='tt-old'`
  )
  raw.close()
  const mine = createDatabase(file, TEST_PROFILE)
  assert.deepEqual(
    mine.filmsInProgress().map((row) => row.contentId),
    ['tt-new', 'tt-old']
  )
  mine.close()
  const other = createDatabase(file, 'profile-other')
  assert.deepEqual(other.filmsInProgress(), [])
  other.close()
})

console.log('filmContinueWatchingRows / mergeContinueWatching — the row')

check('a film row carries its bookmark and no episode', () => {
  const rows = filmContinueWatchingRows(
    [
      {
        contentId: 'tt1',
        positionSeconds: 1500,
        durationSeconds: 6000,
        updatedAt: '2026-11-10T00:00:00.000Z'
      }
    ],
    [film('tt1', 'One')]
  )
  assert.equal(rows.length, 1)
  assert.equal(rows[0].title, 'One')
  assert.equal(rows[0].positionSeconds, 1500)
  assert.equal(rows[0].durationSeconds, 6000)
  assert.equal(rows[0].lastWatchedAt, '2026-11-10T00:00:00.000Z')
})

check('a bookmark whose detail is a show, or missing, is left out', () => {
  const show = { ...film('tt-show'), type: 'series' } as CatalogItem
  const rows = filmContinueWatchingRows(
    [
      {
        contentId: 'tt-show',
        positionSeconds: 600,
        durationSeconds: 2400,
        updatedAt: '2026-11-10T00:00:00.000Z'
      },
      {
        contentId: 'tt-gone',
        positionSeconds: 600,
        durationSeconds: 2400,
        updatedAt: '2026-11-10T00:00:00.000Z'
      }
    ],
    [show]
  )
  assert.deepEqual(rows, [])
})

check('shows and films interleave by when they were last played', () => {
  const at = (id: string, when: string): ContinueWatchingEntry =>
    ({ ...film(id), lastWatchedAt: when }) as ContinueWatchingEntry
  const merged = mergeContinueWatching(
    [at('show-a', '2026-11-12T00:00:00.000Z'), at('show-b', '2026-11-01T00:00:00.000Z')],
    [at('film-a', '2026-11-13T00:00:00.000Z'), at('film-b', '2026-11-05T00:00:00.000Z')]
  )
  assert.deepEqual(
    merged.map((row) => row.id),
    ['film-a', 'show-a', 'film-b', 'show-b']
  )
})

check('no cap: every show and every film in progress comes through', () => {
  const shows = Array.from({ length: 40 }, (_, i) => ({
    ...film(`show-${i}`),
    type: 'series',
    videos: [
      { id: `show-${i}:1:1`, season: 1, episode: 1, released: '2020-01-01' },
      { id: `show-${i}:1:2`, season: 1, episode: 2, released: '2020-01-01' }
    ]
  })) as unknown as CatalogItem[]
  const history = shows.map((show) => ({
    id: show.id,
    type: 'series' as const,
    season: 1,
    episode: 1,
    watchedAt: '2026-11-01T00:00:00.000Z'
  }))
  const films = Array.from({ length: 30 }, (_, i) => ({
    contentId: `film-${i}`,
    positionSeconds: 900,
    durationSeconds: 6000,
    updatedAt: '2026-11-02T00:00:00.000Z'
  }))
  const merged = mergeContinueWatching(
    continueWatchingList(shows, history),
    filmContinueWatchingRows(
      films,
      films.map((f) => film(f.contentId))
    )
  )
  assert.equal(merged.length, 70)
})

console.log(`\n${pass} passed`)
