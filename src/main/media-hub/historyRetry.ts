// Watch-history pushes that did not reach a service, kept until they do.
//
// Marking an episode, un-marking it, marking a season or a whole title
// writes the local row first and then pushes the change to Simkl, Trakt and
// MyAnimeList behind it (tracking.ts's queueRemotePushes). A push that
// failed used to be logged and dropped, so an outage, an expired token or a
// rate limit left the service behind for good with nobody told.
//
// This is the record of what is still owed, on the same terms as the plan
// changes a service refused (watchlists.ts's planned:pending-removals): a
// durable catalog_cache entry, retried at the start of each half-hourly
// watch-sync pass and of a manual Sync, given up on after ten failed tries,
// and stamped with the account it was owed to so nothing is ever sent to a
// different one. One entry per service, title and episode (per season for
// MyAnimeList, which takes a count rather than episodes). A later push for
// the same episode replaces the entry, whichever way it went: the newest
// change is the one the service should end up with, and a push that got
// through clears what an earlier one left owing.
//
// Kept apart from tracking.ts, and free of Electron, so the rules can be
// tested against a real temporary database (tests/trackingPushes.test.ts).

import type { MediaHubDatabase } from './database'
import type { MediaKind } from '../../shared/media-hub/types'

export type HistoryService = 'simkl' | 'trakt' | 'mal'

/** One change a service has not taken yet. */
export interface PendingHistoryPush {
  service: HistoryService
  /** Which way the change went. For MyAnimeList the retry is a recount of
   *  the season from local history either way. */
  action: 'add' | 'remove'
  item: { id: string; type: MediaKind; title: string; year?: string }
  /** Null for a film. */
  season: number | null
  /** Null for a film, and for a MyAnimeList season entry. */
  episode: number | null
  attempts: number
  /** When this entry was written. A retry only settles the entry it read:
   *  one replaced in the meantime is a newer change, and stays. */
  at: number
  /** The service's account mark (settingsStore's trackingAccountMarks) when
   *  the push failed. An entry for any other account is never sent. */
  mark: string
  lastError?: string
}

export type PendingHistoryPushes = Record<string, PendingHistoryPush>

/** Same as planned:pending-removals: how long the record outlives its last
 *  write, and how many failed tries an entry is given. */
export const HISTORY_PENDING_TTL_MS = 30 * 24 * 60 * 60 * 1000
export const HISTORY_PENDING_MAX_ATTEMPTS = 10

/** Per profile: these are changes to one profile's history, and a retry is
 *  only ever checked against, and sent for, that profile. */
export function historyPendingKey(profile: string): string {
  return `history:pending-pushes:v1:${profile}`
}

/** The key one owed change is held under. */
export function historyPushKey(
  service: HistoryService,
  id: string,
  season: number | null,
  episode: number | null
): string {
  if (service === 'mal') return `mal|${id}|${season ?? 'movie'}`
  return `${service}|${id}|${season ?? 'movie'}|${episode ?? 'movie'}`
}

/** The local history key of a row, as db.history() rows are keyed. */
export function watchKeyOf(id: string, season: number | null, episode: number | null): string {
  return `${id}:${season ?? 'movie'}:${episode ?? 'movie'}`
}

type Marks = Record<HistoryService, string>

function isEntry(value: unknown): value is PendingHistoryPush {
  const entry = value as PendingHistoryPush
  return Boolean(
    entry &&
    typeof entry === 'object' &&
    (entry.service === 'simkl' || entry.service === 'trakt' || entry.service === 'mal') &&
    (entry.action === 'add' || entry.action === 'remove') &&
    entry.item &&
    typeof entry.item.id === 'string' &&
    typeof entry.attempts === 'number' &&
    typeof entry.at === 'number' &&
    typeof entry.mark === 'string'
  )
}

/**
 * What is owed, for the accounts connected now. An entry stamped with any
 * other account, or with none, is left out: it belongs to a connection that
 * is gone.
 */
export function readHistoryPending(
  db: Pick<MediaHubDatabase, 'getCache'>,
  profile: string,
  marks: Marks
): PendingHistoryPushes {
  const stored = db.getCache<Record<string, unknown>>(historyPendingKey(profile), {
    allowExpired: true
  })
  const out: PendingHistoryPushes = {}
  if (!stored || typeof stored !== 'object') return out
  for (const [key, value] of Object.entries(stored)) {
    if (!isEntry(value)) continue
    if (!value.mark || value.mark !== marks[value.service]) continue
    out[key] = value
  }
  return out
}

export function writeHistoryPending(
  db: Pick<MediaHubDatabase, 'putCache'>,
  profile: string,
  pending: PendingHistoryPushes
): void {
  db.putCache(historyPendingKey(profile), pending, HISTORY_PENDING_TTL_MS, { durable: true })
}

/** One push as it was made: which service, which rows, which way, and how
 *  it went. `error` undefined means it got through. */
export interface HistoryPushOutcome {
  service: HistoryService
  mark: string
  item: PendingHistoryPush['item']
  rows: readonly { season: number | null; episode: number | null }[]
  action: 'add' | 'remove'
  error?: string
}

/**
 * Folds one push's outcome into what is owed. A push that got through
 * clears every entry it covered; one that failed writes them, replacing
 * whatever an earlier push for the same episode left.
 */
export function recordHistoryPush(
  pending: PendingHistoryPushes,
  outcome: HistoryPushOutcome,
  now: number
): PendingHistoryPushes {
  const next = { ...pending }
  const rows =
    outcome.service === 'mal'
      ? [...new Set(outcome.rows.map((row) => row.season))].map((season) => ({
          season,
          episode: null
        }))
      : outcome.rows
  for (const row of rows) {
    const key = historyPushKey(outcome.service, outcome.item.id, row.season, row.episode)
    if (outcome.error === undefined) {
      delete next[key]
      continue
    }
    if (!outcome.mark) continue
    next[key] = {
      service: outcome.service,
      action: outcome.action,
      item: outcome.item,
      season: row.season,
      episode: outcome.service === 'mal' ? null : row.episode,
      attempts: 0,
      at: now,
      mark: outcome.mark,
      lastError: outcome.error
    }
  }
  return next
}

/** One request's worth of owed changes: a service, a title and a direction. */
export interface HistoryRetryBatch {
  service: HistoryService
  action: 'add' | 'remove'
  item: PendingHistoryPush['item']
  rows: { season: number | null; episode: number | null }[]
  /** The entries it settles, each with the `at` it was read at. */
  entries: { key: string; at: number }[]
}

/**
 * What a retry sends, grouped one request per service, title and direction.
 *
 * An entry local has since moved away from is dropped, not sent: an add for
 * a row no longer held here, or a removal for one that is back. Whatever
 * moved it pushed its own change (or, for a row a catch-up brought in, the
 * service already holds it), and replaying the old one would undo it.
 * MyAnimeList entries are a recount of local history, so they always go.
 */
export function historyRetryBatches(
  pending: PendingHistoryPushes,
  heldLocally: ReadonlySet<string>
): { batches: HistoryRetryBatch[]; dropped: string[] } {
  const batches = new Map<string, HistoryRetryBatch>()
  const dropped: string[] = []
  for (const [key, entry] of Object.entries(pending)) {
    if (entry.service !== 'mal') {
      const held = heldLocally.has(watchKeyOf(entry.item.id, entry.season, entry.episode))
      if (held !== (entry.action === 'add')) {
        dropped.push(key)
        continue
      }
    }
    const group = `${entry.service}|${entry.item.id}|${entry.action}`
    const batch = batches.get(group) ?? {
      service: entry.service,
      action: entry.action,
      item: entry.item,
      rows: [],
      entries: []
    }
    batch.rows.push({ season: entry.season, episode: entry.episode })
    batch.entries.push({ key, at: entry.at })
    batches.set(group, batch)
  }
  return { batches: [...batches.values()], dropped }
}

/**
 * Folds a retry's outcome back in. `error` undefined is success and clears
 * the batch's entries; `null` is a push that could not be expressed to the
 * service at all, which no retry will change, so they are dropped as well.
 * A failure counts an attempt, and an entry that reaches the cap is let go
 * and returned as abandoned. Only entries still as the batch read them are
 * touched: a newer push for the same episode wins.
 */
export function settleHistoryRetry(
  pending: PendingHistoryPushes,
  batch: HistoryRetryBatch,
  error: string | null | undefined
): { pending: PendingHistoryPushes; abandoned: PendingHistoryPush[] } {
  const next = { ...pending }
  const abandoned: PendingHistoryPush[] = []
  for (const { key, at } of batch.entries) {
    const entry = next[key]
    if (!entry || entry.at !== at) continue
    if (typeof error !== 'string') {
      delete next[key]
      continue
    }
    const attempts = entry.attempts + 1
    if (attempts >= HISTORY_PENDING_MAX_ATTEMPTS) {
      delete next[key]
      abandoned.push({ ...entry, attempts, lastError: error })
      continue
    }
    next[key] = { ...entry, attempts, lastError: error }
  }
  return { pending: next, abandoned }
}

/**
 * Local history keys whose removal is still owed to Simkl. The catch-up
 * (simklCatchUp.ts) treats these as already held, so a viewing somebody
 * un-marked here is not brought back from Simkl before the removal lands.
 */
export function simklRemovalsOwed(pending: PendingHistoryPushes): Set<string> {
  const keys = new Set<string>()
  for (const entry of Object.values(pending)) {
    if (entry.service !== 'simkl' || entry.action !== 'remove') continue
    keys.add(watchKeyOf(entry.item.id, entry.season, entry.episode))
  }
  return keys
}
