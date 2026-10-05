// Watched episodes compared show by show, and the review panel's choices
// (src/main/media-hub/episodeSync.ts).
//
// What is pinned, and why:
//
//  - The per-show diff from two sets. Progress is a set of watched episodes,
//    not a position: "here S1E8, Trakt S2E2" is the episodes each side holds
//    that the other does not, and nothing else.
//  - The comparison only ever adds. Episodes held here that a service lacks
//    are sent to it; what only Trakt holds is taken in on the first
//    comparison against that account and never after (the pull does that);
//    nothing is removed anywhere. A read that failed writes nothing and
//    records nothing (rule 5), and is read again next time.
//  - An anime season the placing rules cannot name an entry for is listed as
//    "cannot be sent", never sent by position.
//  - The record of what was merged survives a restart, belongs to the
//    account it was made under, and does not bring a reviewed row back for
//    the same unsendable set.
//  - Each choice's exact requests to Simkl and Trakt: always named episodes,
//    never a show reference without them (rule 3; at Simkl that removes the
//    whole show's history).
//  - A choice stands once made: a push that then fails is kept and retried,
//    and does not bring the row back or the episodes back here.
//
// Pinned against a real temporary database, as tests/trackingPushes.test.ts
// does, because "survives a restart" is a property of the store.
//
// Run with: npx tsx tests/episodeSync.test.ts

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createDatabase } from '../src/main/media-hub/database'
import {
  compareEpisodeSets,
  comparedKey,
  decideShow,
  liveShowSync,
  noteArrivals,
  noteMerge,
  readShowSync,
  showEpisodeDiff,
  simklAnimeRead,
  simklShowsRead,
  traktShowsRead,
  writeShowSync,
  type CompareDeps,
  type Ep,
  type EpisodeService,
  type EpisodeSource,
  type RemoteRead,
  type ShowSyncRecord,
  type SyncShow
} from '../src/main/media-hub/episodeSync'
import {
  historyRetryBatches,
  readHistoryPending,
  removalsOwed,
  settleHistoryRetry,
  watchKeyOf,
  writeHistoryPending,
  type HistoryService,
  type PendingHistoryPushes
} from '../src/main/media-hub/historyRetry'
import { titleHistoryPayload as simklTitleHistoryPayload } from '../src/main/media-hub/simkl'
import {
  isTraktPushable,
  titleHistoryPayload as traktTitleHistoryPayload
} from '../src/main/media-hub/trakt'
import { bySeason } from '../src/main/media-hub/titleStatusRules'
import { hasExpressibleSimklId, toSimklAnimeEpisode } from '../src/shared/media-hub/serviceIds'

let pass = 0
async function check(name: string, fn: () => void | Promise<void>): Promise<void> {
  try {
    await fn()
    pass++
    console.log(`  ok  ${name}`)
  } catch (error) {
    console.log(`FAIL  ${name}\n      ${(error as Error).message}`)
    process.exitCode = 1
  }
}

const PROFILE = 'profile-a'
const MARKS = { simkl: 'simkl-1', trakt: 'trakt-1', mal: '' }
const T0 = Date.parse('2026-09-01T12:00:00Z')
const OLD = '2026-01-01T10:00:00.000Z'

const SHOW: SyncShow = { id: 'tt0000001', type: 'series', title: 'Severance', year: '2022' }
const OTHER: SyncShow = { id: 'tt0000002', type: 'series', title: 'Andor', year: '2022' }
const ANIME: SyncShow = { id: 'kitsu:100', type: 'anime', title: 'Frieren' }

/** kitsu:100 fronts a merged show: season 2 is kitsu:200, and season 3 has
 *  no member the placing rules can show (animeSiblingsWhenGrouped blanks it). */
const SIBLINGS = (id: string): readonly (string | null)[] | undefined =>
  id === 'kitsu:100' ? ['kitsu:200', null] : undefined

function canSend(service: EpisodeService, show: { id: string; type: string }, ep: Ep): boolean {
  if (service === 'trakt') {
    return isTraktPushable({ id: show.id, type: show.type as 'series', title: '' })
  }
  if (!hasExpressibleSimklId(show.id)) return false
  if (show.type !== 'anime') return true
  return toSimklAnimeEpisode({ id: show.id, ...ep }, SIBLINGS) !== null
}

function eps(season: number, ...episodes: number[]): Ep[] {
  return episodes.map((episode) => ({ season, episode }))
}

function range(season: number, from: number, to: number): Ep[] {
  const out: Ep[] = []
  for (let episode = from; episode <= to; episode++) out.push({ season, episode })
  return out
}

function tempDb(): ReturnType<typeof createDatabase> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-episode-sync-'))
  return createDatabase(path.join(dir, 'test.sqlite'), PROFILE)
}

function dbFile(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'r3-episode-sync-'))
  return path.join(dir, 'test.sqlite')
}

function seed(
  db: ReturnType<typeof createDatabase>,
  show: SyncShow,
  rows: Ep[],
  watchedAt = OLD
): void {
  db.importWatched(
    rows.map((ep) => ({
      id: show.id,
      type: show.type,
      title: show.title,
      season: ep.season,
      episode: ep.episode,
      watchedAt
    }))
  )
}

function heldKeys(db: ReturnType<typeof createDatabase>, id: string): string[] {
  return db
    .history()
    .filter((row) => row.id === id)
    .map((row) => `${row.season}:${row.episode}`)
    .sort()
}

function keysOf(list: Ep[]): string[] {
  return list.map((ep) => `${ep.season}:${ep.episode}`).sort()
}

/** A read built from plain lists, as the real reads produce. */
function readOf(
  shows: Array<{ show: SyncShow; eps: Ep[] }>,
  covers: RemoteRead['covers'] = (row) => row.type === 'series'
): RemoteRead {
  const map = new Map(
    shows.map(({ show, eps: list }) => [
      show.id,
      {
        show,
        episodes: new Map(list.map((ep) => [`${ep.season}:${ep.episode}`, OLD] as const))
      }
    ])
  )
  return { shows: map, covers }
}

interface Harness {
  deps: CompareDeps
  reads: EpisodeSource[]
  sent: Array<{ service: EpisodeService; id: string; eps: Ep[] }>
  stamps: Partial<Record<EpisodeSource, string | null>>
  answer: Partial<Record<EpisodeSource, () => RemoteRead>>
  pending: Set<string>
}

function harness(db: ReturnType<typeof createDatabase>): Harness {
  const h: Harness = {
    reads: [],
    sent: [],
    stamps: {},
    answer: {},
    pending: new Set(),
    deps: undefined as unknown as CompareDeps
  }
  h.deps = {
    db,
    marks: () => MARKS,
    stamp: (source) => h.stamps[source] ?? null,
    read: async (source) => {
      h.reads.push(source)
      const answer = h.answer[source]
      if (!answer) throw new Error(`no answer for ${source}`)
      return answer()
    },
    pending: () => h.pending,
    canSend: (service, show, ep) => canSend(service, show, ep),
    send: (service, show, list) => h.sent.push({ service, id: show.id, eps: list }),
    backup: () => {},
    announce: () => {},
    now: () => T0,
    log: () => {}
  }
  return h
}

/** The bodies the retry sends for what a choice queued: the same builders
 *  tracking.ts's sendHistoryRetry uses, one request per service, title and
 *  direction. */
function bodies(
  pending: PendingHistoryPushes,
  held: ReadonlySet<string>
): Array<{ service: HistoryService; action: 'add' | 'remove'; body: unknown }> {
  const out: Array<{ service: HistoryService; action: 'add' | 'remove'; body: unknown }> = []
  for (const batch of historyRetryBatches(pending, held).batches) {
    const seasons = bySeason(
      batch.rows
        .filter((row) => row.episode != null)
        .map((row) => ({ season: row.season ?? 1, episode: row.episode as number }))
    )
    const item = { ...batch.item, year: batch.item.year ?? '' }
    if (batch.service === 'simkl') {
      out.push({
        service: 'simkl',
        action: batch.action,
        body: simklTitleHistoryPayload(item, seasons, SIBLINGS)
      })
    } else if (batch.service === 'trakt') {
      out.push({
        service: 'trakt',
        action: batch.action,
        body: traktTitleHistoryPayload(item, seasons)
      })
    } else {
      out.push({ service: 'mal', action: batch.action, body: batch.rows.map((r) => r.season) })
    }
  }
  return out
}

/** No show or anime entry in a body goes out without named episodes. */
function assertNamesEpisodes(body: unknown): void {
  const value = body as {
    shows?: Array<{ seasons?: Array<{ episodes?: unknown[] }> }>
    anime?: Array<{ episodes?: unknown[] }>
  }
  for (const show of value.shows ?? []) {
    assert.ok(show.seasons?.length, 'a show reference with no seasons')
    for (const season of show.seasons ?? []) assert.ok(season.episodes?.length)
  }
  for (const entry of value.anime ?? []) assert.ok(entry.episodes?.length)
}

function decideDeps(db: ReturnType<typeof createDatabase>, marks = MARKS) {
  return {
    db,
    marks: () => marks,
    canSend: (service: EpisodeService, show: SyncShow, ep: Ep) => canSend(service, show, ep),
    readPending: () => readHistoryPending(db, PROFILE, marks),
    writePending: (pending: PendingHistoryPushes) => writeHistoryPending(db, PROFILE, pending),
    backup: () => {},
    now: () => T0
  }
}

function recordWith(...notes: Parameters<typeof noteMerge>[1][]): ShowSyncRecord {
  let record: ShowSyncRecord = { entries: {}, quiet: {} }
  for (const note of notes) record = noteMerge(record, note, T0)
  return record
}

async function main(): Promise<void> {
  // --- the per-show diff ---------------------------------------------------

  await check('the diff is the episodes each side holds that the other does not', () => {
    // Here (and Simkl): season 1 to episode 8. Trakt: all of season 1 and
    // season 2 to episode 2.
    const here = range(1, 1, 8)
    const trakt = [...range(1, 1, 10), ...range(2, 1, 2)]
    const diff = showEpisodeDiff(here, trakt)
    assert.deepEqual(diff.localOnly, [])
    assert.deepEqual(keysOf(diff.remoteOnly), keysOf([...eps(1, 9, 10), ...eps(2, 1, 2)]))
    // Either way round, and a gap is a difference like any other.
    const gap = showEpisodeDiff([...eps(1, 1, 2, 3, 5)], [...eps(1, 1, 2, 4)])
    assert.deepEqual(gap.localOnly, eps(1, 3, 5))
    assert.deepEqual(gap.remoteOnly, eps(1, 4))
  })

  // --- the reads -----------------------------------------------------------

  await check("Trakt's watched shows read as a set per show; not a list is no answer", () => {
    const read = traktShowsRead([
      {
        show: { title: 'Severance', year: 2022, ids: { imdb: 'tt0000001' } },
        seasons: [
          {
            number: 1,
            episodes: [
              { number: 1, last_watched_at: OLD },
              { number: 2, last_watched_at: OLD }
            ]
          }
        ]
      },
      // No IMDb id: nothing here can be matched to it.
      { show: { title: 'Unknown', ids: { trakt: 5 } }, seasons: [] }
    ])
    assert.deepEqual([...read.shows.keys()], ['tt0000001'])
    assert.deepEqual([...read.shows.get('tt0000001')!.episodes.keys()], ['1:1', '1:2'])
    assert.equal(read.covers({ id: 'tt0000001', type: 'series', season: 1 }), true)
    // Anime is not compared at Trakt.
    assert.equal(read.covers({ id: 'kitsu:100', type: 'anime', season: 1 }), false)
    assert.throws(() => traktShowsRead({}))
  })

  await check("Simkl's shows list reads by IMDb id and leaves anime out", () => {
    const read = simklShowsRead({
      shows: [
        {
          show: { title: 'Severance', year: 2022, ids: { simkl: 1, imdb: 'tt0000001' } },
          seasons: [{ number: 1, episodes: [{ number: 3, watched_at: OLD }] }]
        },
        {
          anime_type: 'tv',
          show: { title: 'An anime', ids: { simkl: 2, mal: 9 } },
          seasons: [{ number: 1, episodes: [{ number: 1, watched_at: OLD }] }]
        }
      ]
    })
    assert.deepEqual([...read.shows.keys()], ['tt0000001'])
    assert.deepEqual([...read.shows.get('tt0000001')!.episodes.keys()], ['1:3'])
  })

  await check('an anime entry nobody could look up makes the whole read fail', async () => {
    const payload = {
      anime: [{ show: { title: 'Frieren', ids: { simkl: 3, mal: 52991 } }, episodes: [] }]
    }
    await assert.rejects(simklAnimeRead(payload, async () => ({ kind: 'unanswered' })))
  })

  await check('an anime entry whose place is not its season keeps its show out', async () => {
    const payload = {
      anime: [
        {
          show: { title: 'Frieren', ids: { simkl: 3, kitsu: 100 } },
          episodes: [{ number: 1, watched_at: OLD }]
        },
        {
          show: { title: 'Frieren 2', ids: { simkl: 4, kitsu: 200 } },
          episodes: [{ number: 1, watched_at: OLD }]
        }
      ]
    }
    const read = await simklAnimeRead(payload, async (title) =>
      title.kitsu === 100
        ? { kind: 'placed', id: 'kitsu:100', season: 1 }
        : { kind: 'mismatched', ids: ['kitsu:100', 'kitsu:200'] }
    )
    assert.equal(read.shows.has('kitsu:100'), false)
    assert.equal(read.covers({ id: 'kitsu:100', type: 'anime', season: 1 }), false)
  })

  // --- the comparison ------------------------------------------------------

  await check(
    'a first comparison with Trakt takes in its episodes of shows held here and sends it what it lacks',
    async () => {
      const db = tempDb()
      seed(db, SHOW, range(1, 1, 8))
      seed(db, OTHER, range(1, 1, 3))
      const h = harness(db)
      h.stamps['trakt-shows'] = 'stamp-1'
      h.answer['trakt-shows'] = () =>
        readOf([
          { show: SHOW, eps: [...range(1, 1, 10), ...range(2, 1, 2)] },
          // A show not held here is the import's, not this comparison's.
          { show: { id: 'tt0000003', type: 'series', title: 'Not here' }, eps: eps(1, 1) }
        ])
      const report = await compareEpisodeSets(h.deps)
      assert.deepEqual(report.compared, ['trakt-shows'])
      assert.equal(report.added, 4)
      assert.deepEqual(heldKeys(db, SHOW.id), keysOf([...range(1, 1, 10), ...range(2, 1, 2)]))
      assert.deepEqual(heldKeys(db, 'tt0000003'), [])
      // Andor is not at Trakt at all: all three episodes go to it, as an add.
      assert.deepEqual(h.sent, [{ service: 'trakt', id: OTHER.id, eps: range(1, 1, 3) }])
      const rows = liveShowSync(readShowSync(db, PROFILE), MARKS)
      const severance = rows.find((row) => row.id === SHOW.id)!
      assert.deepEqual(
        keysOf(severance.parts.trakt!.arrived),
        keysOf([...eps(1, 9, 10), ...eps(2, 1, 2)])
      )
      const andor = rows.find((row) => row.id === OTHER.id)!
      assert.deepEqual(andor.parts.trakt!.sent, range(1, 1, 3))
      // Same stamp next time: no request at all.
      await compareEpisodeSets(h.deps)
      assert.deepEqual(h.reads, ['trakt-shows'])
      db.close()
    }
  )

  await check('after the first, what only the service holds is left to the pull', async () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 2))
    const h = harness(db)
    h.stamps['trakt-shows'] = 'stamp-1'
    h.answer['trakt-shows'] = () => readOf([{ show: SHOW, eps: range(1, 1, 2) }])
    await compareEpisodeSets(h.deps)
    h.stamps['trakt-shows'] = 'stamp-2'
    h.answer['trakt-shows'] = () => readOf([{ show: SHOW, eps: range(1, 1, 3) }])
    const report = await compareEpisodeSets(h.deps)
    assert.equal(report.added, 0)
    assert.deepEqual(heldKeys(db, SHOW.id), keysOf(range(1, 1, 2)))
    db.close()
  })

  await check('Simkl is never taken in from here: the catch-up does that', async () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 2))
    const h = harness(db)
    h.stamps['simkl-shows'] = 'stamp-1'
    h.answer['simkl-shows'] = () => readOf([{ show: SHOW, eps: range(1, 1, 5) }])
    const report = await compareEpisodeSets(h.deps)
    assert.equal(report.added, 0)
    assert.deepEqual(h.sent, [])
    db.close()
  })

  await check(
    "Simkl's lists are read again at most every six hours, however often they move",
    async () => {
      const db = tempDb()
      seed(db, SHOW, range(1, 1, 2))
      const h = harness(db)
      let clock = T0
      h.deps.now = () => clock
      h.stamps['simkl-shows'] = 'stamp-1'
      h.answer['simkl-shows'] = () => readOf([{ show: SHOW, eps: range(1, 1, 2) }])
      await compareEpisodeSets(h.deps)
      h.stamps['simkl-shows'] = 'stamp-2'
      clock += 60 * 60 * 1000
      await compareEpisodeSets(h.deps)
      assert.deepEqual(h.reads, ['simkl-shows'])
      clock += 6 * 60 * 60 * 1000
      await compareEpisodeSets(h.deps)
      assert.deepEqual(h.reads, ['simkl-shows', 'simkl-shows'])
      db.close()
    }
  )

  await check('a failed read writes nothing, records nothing, and is read again', async () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 2))
    const before = JSON.stringify(db.history())
    const h = harness(db)
    h.stamps['trakt-shows'] = 'stamp-1'
    // No answer: the read throws.
    const report = await compareEpisodeSets(h.deps)
    assert.deepEqual(report, { compared: [], added: 0, sent: 0 })
    assert.equal(JSON.stringify(db.history()), before)
    assert.deepEqual(readShowSync(db, PROFILE), { entries: {}, quiet: {} })
    assert.equal(db.getCache(comparedKey(PROFILE), { allowExpired: true }), null)
    assert.deepEqual(h.sent, [])
    await compareEpisodeSets(h.deps)
    assert.deepEqual(h.reads, ['trakt-shows', 'trakt-shows'])
    db.close()
  })

  await check(
    'an episode marked moments ago, or with a change owed, is not sent again',
    async () => {
      const db = tempDb()
      seed(db, SHOW, eps(1, 1))
      seed(db, SHOW, eps(1, 2), new Date(T0 - 60 * 1000).toISOString())
      seed(db, SHOW, eps(1, 3))
      const h = harness(db)
      h.pending.add(watchKeyOf(SHOW.id, 1, 3))
      h.stamps['simkl-shows'] = 'stamp-1'
      h.answer['simkl-shows'] = () => readOf([{ show: SHOW, eps: [] }])
      await compareEpisodeSets(h.deps)
      assert.deepEqual(h.sent, [{ service: 'simkl', id: SHOW.id, eps: eps(1, 1) }])
      db.close()
    }
  )

  await check(
    'an anime season with no entry to name is listed as cannot be sent, not sent',
    async () => {
      const db = tempDb()
      seed(db, ANIME, [...range(1, 1, 3), ...range(2, 1, 2), ...range(3, 1, 1)])
      const h = harness(db)
      h.stamps['simkl-anime'] = 'stamp-1'
      h.answer['simkl-anime'] = () =>
        readOf([{ show: ANIME, eps: range(1, 1, 3) }], (row) => row.type === 'anime')
      await compareEpisodeSets(h.deps)
      // Season 2 has an entry (kitsu:200) and goes to it; season 3 has none.
      assert.deepEqual(h.sent, [{ service: 'simkl', id: ANIME.id, eps: range(2, 1, 2) }])
      const row = liveShowSync(readShowSync(db, PROFILE), MARKS)[0]
      assert.deepEqual(row.parts.simkl!.unsendable, range(3, 1, 1))
      // And the request that goes out names season 2's own entry, by episode.
      assert.deepEqual(
        simklTitleHistoryPayload({ ...ANIME, year: '' }, bySeason(range(2, 1, 2)), SIBLINGS),
        { anime: [{ ids: { kitsu: 200 }, episodes: [{ number: 1 }, { number: 2 }] }] }
      )
      db.close()
    }
  )

  // --- the record ----------------------------------------------------------

  await check('the record survives a restart and belongs to the account it was made under', () => {
    const file = dbFile()
    const before = createDatabase(file, PROFILE)
    const record = recordWith(
      { service: 'trakt', mark: 'trakt-1', show: SHOW, arrived: eps(1, 9, 10) },
      { service: 'simkl', mark: 'simkl-1', show: SHOW, sent: eps(1, 9, 10) }
    )
    assert.equal(writeShowSync(before, PROFILE, record), true)
    before.close()
    const db = createDatabase(file, PROFILE)
    assert.deepEqual(readShowSync(db, PROFILE), record)
    // Another Trakt account connected: its part is inert, Simkl's stays.
    const rows = liveShowSync(readShowSync(db, PROFILE), { ...MARKS, trakt: 'trakt-2' })
    assert.deepEqual(Object.keys(rows[0].parts), ['simkl'])
    // Another profile has a record of its own.
    assert.deepEqual(readShowSync(db, 'profile-b'), { entries: {}, quiet: {} })
    db.close()
  })

  await check('the same unsendable set does not bring a reviewed row back; a new one does', () => {
    let record = recordWith({
      service: 'simkl',
      mark: 'simkl-1',
      show: ANIME,
      unsendable: range(3, 1, 1)
    })
    assert.equal(Object.keys(record.entries).length, 1)
    // Kept: the row goes.
    record = { entries: {}, quiet: record.quiet }
    record = noteMerge(
      record,
      { service: 'simkl', mark: 'simkl-1', show: ANIME, unsendable: range(3, 1, 1) },
      T0
    )
    assert.deepEqual(record.entries, {})
    record = noteMerge(
      record,
      { service: 'simkl', mark: 'simkl-1', show: ANIME, unsendable: range(3, 1, 2) },
      T0
    )
    assert.equal(Object.keys(record.entries).length, 1)
  })

  await check('a row no pass has added to for 90 days goes', () => {
    let record = recordWith({ service: 'trakt', mark: 'trakt-1', show: SHOW, arrived: eps(1, 9) })
    record = noteMerge(
      record,
      { service: 'trakt', mark: 'trakt-1', show: OTHER, arrived: eps(1, 1) },
      T0 + 91 * 24 * 60 * 60 * 1000
    )
    assert.deepEqual(Object.keys(record.entries), [OTHER.id])
  })

  await check('what a pull wrote is noted per show as arrivals; films are not', () => {
    const record = noteArrivals(
      { entries: {}, quiet: {} },
      'simkl',
      'simkl-1',
      [
        { id: SHOW.id, type: 'series', title: 'Severance', season: 1, episode: 4, watchedAt: OLD },
        { id: 'tt9', type: 'movie', title: 'A film', watchedAt: OLD }
      ],
      T0
    )
    assert.deepEqual(Object.keys(record.entries), [SHOW.id])
    assert.deepEqual(record.entries[SHOW.id].parts.simkl!.arrived, eps(1, 4))
  })

  // --- the choices ---------------------------------------------------------

  await check('Undo removes what arrived here, at its source, and where it was passed on', () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 10))
    writeShowSync(
      db,
      PROFILE,
      recordWith(
        { service: 'trakt', mark: 'trakt-1', show: SHOW, arrived: eps(1, 9, 10) },
        { service: 'simkl', mark: 'simkl-1', show: SHOW, sent: eps(1, 9, 10) }
      )
    )
    const outcome = decideShow(decideDeps(db), SHOW.id, 'undo')
    assert.equal(outcome.ok, true)
    assert.equal(outcome.removedHere, 2)
    assert.deepEqual(heldKeys(db, SHOW.id), keysOf(range(1, 1, 8)))
    const pending = readHistoryPending(db, PROFILE, MARKS)
    const sent = bodies(pending, new Set(heldKeys(db, SHOW.id).map((k) => `${SHOW.id}:${k}`)))
    const named = { title: 'Severance', year: 2022, ids: { imdb: SHOW.id } }
    assert.deepEqual(sent, [
      {
        service: 'trakt',
        action: 'remove',
        body: {
          shows: [
            {
              ids: { imdb: SHOW.id },
              seasons: [{ number: 1, episodes: [{ number: 9 }, { number: 10 }] }]
            }
          ]
        }
      },
      {
        service: 'simkl',
        action: 'remove',
        body: {
          shows: [{ ...named, seasons: [{ number: 1, episodes: [{ number: 9 }, { number: 10 }] }] }]
        }
      }
    ])
    for (const { body } of sent) assertNamesEpisodes(body)
    // The row is gone, and the removals are held back from the pulls.
    assert.deepEqual(liveShowSync(readShowSync(db, PROFILE), MARKS), [])
    assert.ok(removalsOwed(pending, 'trakt').has(watchKeyOf(SHOW.id, 1, 9)))
    db.close()
  })

  await check(
    '"Make Trakt match here" takes back what came from it and sends what it lacks',
    () => {
      const db = tempDb()
      seed(db, SHOW, [...range(1, 1, 3), ...eps(2, 1)])
      writeShowSync(
        db,
        PROFILE,
        recordWith(
          {
            service: 'trakt',
            mark: 'trakt-1',
            show: SHOW,
            arrived: eps(2, 1),
            sent: range(1, 1, 3)
          },
          { service: 'simkl', mark: 'simkl-1', show: SHOW, arrived: eps(1, 1) }
        )
      )
      const outcome = decideShow(decideDeps(db), SHOW.id, 'service-match-here', 'trakt')
      assert.equal(outcome.ok, true)
      assert.deepEqual(heldKeys(db, SHOW.id), keysOf(range(1, 1, 3)))
      const held = new Set(heldKeys(db, SHOW.id).map((k) => `${SHOW.id}:${k}`))
      const sent = bodies(readHistoryPending(db, PROFILE, MARKS), held)
      assert.deepEqual(sent, [
        {
          service: 'trakt',
          action: 'remove',
          body: {
            shows: [{ ids: { imdb: SHOW.id }, seasons: [{ number: 2, episodes: [{ number: 1 }] }] }]
          }
        },
        {
          service: 'trakt',
          action: 'add',
          body: {
            shows: [
              {
                ids: { imdb: SHOW.id },
                seasons: [{ number: 1, episodes: [{ number: 1 }, { number: 2 }, { number: 3 }] }]
              }
            ]
          }
        }
      ])
      // Only Trakt's part was settled; Simkl's stays for review.
      const rows = liveShowSync(readShowSync(db, PROFILE), MARKS)
      assert.deepEqual(Object.keys(rows[0].parts), ['simkl'])
      db.close()
    }
  )

  await check(
    '"Make here match Trakt" removes what Trakt lacked here and elsewhere, and passes its episodes on',
    () => {
      const db = tempDb()
      seed(db, SHOW, [...range(1, 1, 4), ...eps(2, 1)])
      writeShowSync(
        db,
        PROFILE,
        recordWith({
          service: 'trakt',
          mark: 'trakt-1',
          show: SHOW,
          arrived: eps(2, 1),
          sent: eps(1, 4)
        })
      )
      const outcome = decideShow(decideDeps(db), SHOW.id, 'here-match-service', 'trakt')
      assert.equal(outcome.ok, true)
      assert.equal(outcome.removedHere, 1)
      assert.deepEqual(heldKeys(db, SHOW.id), keysOf([...range(1, 1, 3), ...eps(2, 1)]))
      const held = new Set(heldKeys(db, SHOW.id).map((k) => `${SHOW.id}:${k}`))
      const named = { title: 'Severance', year: 2022, ids: { imdb: SHOW.id } }
      assert.deepEqual(bodies(readHistoryPending(db, PROFILE, MARKS), held), [
        {
          service: 'trakt',
          action: 'remove',
          body: {
            shows: [{ ids: { imdb: SHOW.id }, seasons: [{ number: 1, episodes: [{ number: 4 }] }] }]
          }
        },
        {
          service: 'simkl',
          action: 'remove',
          body: { shows: [{ ...named, seasons: [{ number: 1, episodes: [{ number: 4 }] }] }] }
        },
        {
          service: 'simkl',
          action: 'add',
          body: { shows: [{ ...named, seasons: [{ number: 2, episodes: [{ number: 1 }] }] }] }
        }
      ])
      db.close()
    }
  )

  await check(
    'a choice on an anime says what cannot be sent, and sends Simkl only named entries',
    () => {
      const db = tempDb()
      seed(db, ANIME, [...range(1, 1, 2), ...eps(2, 1), ...eps(3, 1)])
      writeShowSync(
        db,
        PROFILE,
        recordWith({
          service: 'simkl',
          mark: 'simkl-1',
          show: ANIME,
          sent: eps(2, 1),
          unsendable: eps(3, 1)
        })
      )
      const outcome = decideShow(decideDeps(db), ANIME.id, 'here-match-service', 'simkl')
      assert.equal(outcome.ok, true)
      // Trakt is never sent anime.
      assert.deepEqual(outcome.cannotSend, [{ service: 'trakt', seasons: [2, 3] }])
      const held = new Set(heldKeys(db, ANIME.id).map((k) => `${ANIME.id}:${k}`))
      const sent = bodies(readHistoryPending(db, PROFILE, MARKS), held)
      assert.deepEqual(sent, [
        {
          service: 'simkl',
          action: 'remove',
          body: { anime: [{ ids: { kitsu: 200 }, episodes: [{ number: 1 }] }] }
        }
      ])
      for (const { body } of sent) assertNamesEpisodes(body)
      db.close()
    }
  )

  await check('a choice stands when its push then fails', () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 10))
    writeShowSync(
      db,
      PROFILE,
      recordWith({ service: 'trakt', mark: 'trakt-1', show: SHOW, arrived: eps(1, 9, 10) })
    )
    decideShow(decideDeps(db), SHOW.id, 'undo')
    const pending = readHistoryPending(db, PROFILE, MARKS)
    const held = new Set(heldKeys(db, SHOW.id).map((k) => `${SHOW.id}:${k}`))
    const [batch] = historyRetryBatches(pending, held).batches
    const settled = settleHistoryRetry(pending, batch, 'Request failed (503)', { now: T0 })
    writeHistoryPending(db, PROFILE, settled.pending)
    const after = readHistoryPending(db, PROFILE, MARKS)
    // Still owed, one attempt spent...
    assert.equal(Object.values(after).length, 2)
    assert.ok(Object.values(after).every((entry) => entry.attempts === 1))
    // ...and the choice is as it was made: the row stays gone, and so do the
    // episodes here.
    assert.deepEqual(liveShowSync(readShowSync(db, PROFILE), MARKS), [])
    assert.deepEqual(heldKeys(db, SHOW.id), keysOf(range(1, 1, 8)))
    db.close()
  })

  await check('Keep drops the row and changes nothing else', () => {
    const db = tempDb()
    seed(db, SHOW, range(1, 1, 10))
    writeShowSync(
      db,
      PROFILE,
      recordWith({ service: 'trakt', mark: 'trakt-1', show: SHOW, arrived: eps(1, 9, 10) })
    )
    const outcome = decideShow(decideDeps(db), SHOW.id, 'keep')
    assert.deepEqual(outcome, { ok: true, queued: false, removedHere: 0, cannotSend: [] })
    assert.deepEqual(heldKeys(db, SHOW.id), keysOf(range(1, 1, 10)))
    assert.deepEqual(readHistoryPending(db, PROFILE, MARKS), {})
    assert.deepEqual(liveShowSync(readShowSync(db, PROFILE), MARKS), [])
    db.close()
  })

  console.log(`\n${pass} passed`)
}

void main()
