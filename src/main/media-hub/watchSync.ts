// The recurring watch-sync pass, and the gate it reads Simkl through.
//
// Every half hour backgroundJobs.ts runs this: the watchlists come in, the
// decisions still owed to the services go out, and the review panel's diff
// is made ready. It used to ask Simkl for five whole lists each time — three
// plan-to-watch lists and two libraries — whether or not anything had
// changed, which is 240 requests a day from a desktop left open. Simkl
// counts requests per PERSON (500 a day on a free account), the phone app is
// paired with the desktop's own token, and Simkl's documentation says a
// client that polls /sync/all-items without reading /sync/activities first
// is one it suspends.
//
// So the pass now asks the one small question first, and reads a list only
// when the answer says that list moved since it was last read:
//
//  - Simkl's plan-to-watch lists, when any kind's stamp moved — or once a
//    day regardless, see SIMKL_LIST_MAX_AGE_MS. Skipped, Simkl counts as
//    NOT having answered the pull, never as having answered with nothing:
//    see watchlists.ts's SimklListSkip.
//  - The library the review panel is diffed against, when the films stamp
//    moved or the films watched HERE did (the diff has two sides, and a
//    film marked here whose push failed moves only this one), and only on a
//    backend whose interface has ever asked for that panel. The phone and
//    TV app never do.
//
// What is OWED is not polling and is not gated: plan changes a service
// refused are retried inside every pull, and queued history decisions are
// flushed on every pass, whatever the gate said.
//
// The dependencies are injected, as in simklCatchUp.ts and for the same
// reason: everything real reaches Electron, and the test drives a pass
// against a real temporary database with the services faked. The catch-up
// shares the list half (pullPlannedGated) so that the two of them read
// Simkl's lists once per change between them, not once each.

import { createHash } from 'node:crypto'

import type { MediaHubDatabase } from './database'
import type { HttpError } from './httpClient'
import { parseSimklActivities, type SimklActivityStamps } from './simklCatchUpRules'
import type { PlannedPullOptions, PlannedSyncReport } from './watchlists'

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/**
 * How long an unchanged Simkl list may go unread.
 *
 * The stamps say when Simkl's side moved. They say nothing about this side,
 * and a few things here change what a read would DO without touching Simkl:
 * a removal given up on after ten attempts (the title is still on the list
 * there, and the pull is what puts it back), two-way sync switched back on,
 * a title Trakt has since let go of whose origin is Simkl. Each waits for
 * the next read, so the wait is bounded — and at a day, which is the bound
 * watchlists.ts already gives its source tags. Three requests a day.
 */
export const SIMKL_LIST_MAX_AGE_MS = 24 * HOUR

/** The record of what has been read; losing it costs one read of each. */
const STATE_TTL_MS = 400 * 24 * HOUR

/**
 * How long a gate Simkl ANSWERED with a failure (a spent quota, a server
 * error) is left alone, doubling per failure in a row. The base is just
 * under the job's own half hour, so one failure costs no run at all.
 */
const GATE_BACKOFF = { base: 25 * MINUTE, cap: 4 * HOUR }
/**
 * And when the answer was 401 or 403: the token was refused. Asked again a
 * few times a day rather than never — a desktop is left running for weeks,
 * and one stray refusal must not end its syncing until somebody restarts it.
 */
const REFUSED_RETRY_MS = 6 * HOUR

const KINDS = ['movies', 'shows', 'anime'] as const

/** One read of Simkl's plan-to-watch lists that answered. */
export interface SimklListRead {
  /** Simkl's stamps as they stood BEFORE the lists were fetched — so a
   *  change that lands during the fetch moves the stamp past this one, and
   *  is read next time rather than missed. */
  stamps: SimklActivityStamps
  at: number
  /** What that read reported, for the report of a pass that skips it. */
  pulled: number
  unmapped: number
}

export interface WatchSyncState {
  /** settingsStore's simklAccountMark when written. */
  account: string
  list: SimklListRead | null
  /** Both sides of the last diff made against a library fetched from Simkl
   *  in that same pass, as they stood before it: Simkl's films stamp, and
   *  the films watched here (localFilmsSignature). Null before one has been. */
  diffed: { movies: string | null; local: string; at: number } | null
}

function stateKey(profile: string): string {
  return `simkl:watch-sync:v1:${profile}`
}

type Loose = Record<string, unknown>

function record(value: unknown): Loose | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Loose) : null
}

function stampOrNull(value: unknown): value is string | null {
  return value === null || typeof value === 'string'
}

function count(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0
}

/**
 * The stored state, if it is a well-formed one for THIS account; otherwise
 * an empty one, and each half on its own.
 *
 * Another account's stamps describe another account's lists, so a new
 * sign-in starts over. A malformed half reads as never read: the cost is
 * one fetch, and the alternative is trusting a record nobody can vouch for
 * to say a list need not be looked at.
 */
export function watchSyncStateFor(stored: unknown, account: string): WatchSyncState {
  const fresh: WatchSyncState = { account, list: null, diffed: null }
  const value = record(stored)
  if (!value || value.account !== account) return fresh
  const list = record(value.list)
  const stamps = record(list?.stamps)
  if (
    list &&
    stamps &&
    KINDS.every((kind) => stampOrNull(stamps[kind])) &&
    typeof list.at === 'number' &&
    Number.isFinite(list.at)
  ) {
    fresh.list = {
      stamps: {
        movies: stamps.movies as string | null,
        shows: stamps.shows as string | null,
        anime: stamps.anime as string | null
      },
      at: list.at,
      pulled: count(list.pulled),
      unmapped: count(list.unmapped)
    }
  }
  const diffed = record(value.diffed)
  if (
    diffed &&
    stampOrNull(diffed.movies) &&
    typeof diffed.local === 'string' &&
    typeof diffed.at === 'number' &&
    Number.isFinite(diffed.at)
  ) {
    fresh.diffed = { movies: diffed.movies, local: diffed.local, at: diffed.at }
  }
  return fresh
}

/**
 * The films watched here, as one short comparable string.
 *
 * The review panel's diff is "which films does this side call watched"
 * against the same question asked of Simkl, so this is its local half:
 * which films, and nothing about when or how often. Simkl's stamp cannot
 * stand in for it. A film marked or cleared here is pushed without being
 * queued, and when that push fails Simkl never hears of it — its stamp
 * stays put while the two sides have just come to disagree.
 */
export function localFilmsSignature(history: readonly { id: unknown; type?: string }[]): string {
  const ids = [
    ...new Set(history.filter((entry) => entry.type === 'movie').map((entry) => String(entry.id)))
  ].sort()
  const digest = createHash('sha256').update(ids.join('|')).digest('hex').slice(0, 16)
  return `${ids.length}:${digest}`
}

/**
 * Whether Simkl's plan-to-watch lists need reading.
 *
 * Any kind's stamp differing from the one the last read was made under, in
 * either direction, is a move. A kind Simkl gives no stamp for is compared
 * like any other: an account with no anime has none, permanently, and
 * reading "no stamp" as "changed" would read all three lists every half
 * hour for everybody who does not watch anime. What that leaves open — a
 * payload this app has stopped understanding, every stamp missing for good
 * — is what the daily read bounds.
 */
export function simklListDue(
  read: SimklListRead | null,
  current: SimklActivityStamps,
  nowMs: number
): boolean {
  if (!read) return true
  // A clock set back leaves `at` in the future, where no age is ever reached.
  if (nowMs < read.at || nowMs - read.at >= SIMKL_LIST_MAX_AGE_MS) return true
  return KINDS.some((kind) => current[kind] !== read.stamps[kind])
}

/** What /sync/activities said, or why nobody could ask. */
export interface SimklGate {
  /** Null when the gate could not be read — never "nothing changed". */
  stamps: SimklActivityStamps | null
  /** When the stamps were in hand. A list fetched before this may predate
   *  them, and is not recorded as read under them. */
  readAt: number
  /** Why `stamps` is null, for the report. */
  error?: string
}

export interface GatedPullDeps {
  db: Pick<MediaHubDatabase, 'activeProfile' | 'getCache' | 'putCache'>
  /** settingsStore's simklAccountMark. Empty when Simkl is not connected. */
  account(): string
  /** watchlists.syncPlannedFromServices, at the caller's own priority. */
  syncPlanned(options: PlannedPullOptions): Promise<PlannedSyncReport>
  now(): number
}

/**
 * The watchlist pull, with Simkl's lists read only if the gate says so.
 *
 * Always runs the pull itself: it is also what retries the plan changes a
 * service refused, and what reads Trakt and MyAnimeList, which have no gate
 * and stay on the caller's timer. What changes is whether Simkl's three
 * lists are among the things it fetches.
 */
export async function pullPlannedGated(
  deps: GatedPullDeps,
  gate: SimklGate
): Promise<PlannedSyncReport> {
  const { db } = deps
  const profile = db.activeProfile()
  const account = deps.account()
  // Nothing to gate: the pull reports Simkl as not connected.
  if (!account) return deps.syncPlanned({})
  if (!gate.stamps) {
    // Never read as "everything changed". Whatever failed the gate — a
    // revoked token, a spent quota — fails the lists too, and fetching
    // them without it is the polling Simkl suspends clients for.
    return deps.syncPlanned({
      skipSimkl: { reason: 'unasked', error: gate.error || 'Simkl could not be asked.' }
    })
  }
  const key = stateKey(profile)
  const read = watchSyncStateFor(db.getCache(key, { allowExpired: true }), account).list
  if (read && !simklListDue(read, gate.stamps, deps.now())) {
    return deps.syncPlanned({
      skipSimkl: { reason: 'unchanged', pulled: read.pulled, unmapped: read.unmapped }
    })
  }
  const report = await deps.syncPlanned({})
  const simkl = report.services.find((entry) => entry.service === 'simkl')
  // Recorded only for a read that vouches for these stamps: Simkl answered
  // it, it began after the stamps were in hand (a pull this call merely
  // joined may not have), and the profile it was applied to and the account
  // it was read from are still the ones it was asked for.
  const vouched =
    simkl?.connected === true &&
    !simkl.error &&
    !simkl.skipped &&
    (report.startedAt ?? 0) >= gate.readAt &&
    db.activeProfile() === profile &&
    deps.account() === account
  if (vouched) {
    // Read again rather than reused: the other half of the record may have
    // been written while the lists were being fetched.
    const state = watchSyncStateFor(db.getCache(key, { allowExpired: true }), account)
    state.list = {
      stamps: gate.stamps,
      at: deps.now(),
      pulled: simkl.pulled,
      unmapped: simkl.unmapped
    }
    db.putCache(key, state, STATE_TTL_MS, { durable: true })
  }
  return report
}

export interface WatchSyncDeps extends GatedPullDeps {
  db: Pick<MediaHubDatabase, 'activeProfile' | 'getCache' | 'putCache' | 'history'>
  /** GET /sync/activities, raw. Throws an HttpError (with `status`) on failure. */
  activities(): Promise<unknown>
  /** Sends the history decisions still queued (tracking's flushPendingPushes). */
  flushPushes(): Promise<unknown>
  /** Whether anything in this process has asked for the review panel's
   *  check. False for the whole life of a backend whose interface has no
   *  such panel, and the diff is then never made. */
  reviewAsked(): boolean
  /** Makes the review panel's diff ready, if its cooldown allows. Resolves
   *  true only when it was made against a library fetched from Simkl just
   *  now — not from the snapshot cache, and not skipped. */
  reconcile(): Promise<boolean>
  log(scope: string, error: unknown): void
}

/**
 * What this process remembers about the gate between passes. Per process,
 * like the catch-up's: a restart is the natural thing to try, and a pause
 * that outlived one would turn a bad hour into a bad day.
 */
export interface WatchSyncMemory {
  /** Whose failures these are. A pause earned by one account must not hold
   *  up the first pass of the one somebody has just connected. */
  account: string
  failures: number
  /** No gate read before this. 0 when nothing is being waited out. */
  retryAt: number
  lastError: string
}

export function newWatchSyncMemory(): WatchSyncMemory {
  return { account: '', failures: 0, retryAt: 0, lastError: '' }
}

function messageOf(error: unknown): string {
  return (error as Error)?.message || String(error)
}

async function readGate(
  deps: WatchSyncDeps,
  memory: WatchSyncMemory,
  account: string
): Promise<SimklGate> {
  if (!account) return { stamps: null, readAt: 0 }
  if (memory.account !== account) {
    memory.account = account
    memory.failures = 0
    memory.retryAt = 0
    memory.lastError = ''
  }
  const startedAt = deps.now()
  if (startedAt < memory.retryAt) return { stamps: null, readAt: 0, error: memory.lastError }
  try {
    const stamps = parseSimklActivities(await deps.activities())
    memory.failures = 0
    memory.retryAt = 0
    memory.lastError = ''
    return { stamps, readAt: deps.now() }
  } catch (error) {
    deps.log('job:watch-sync:activities', error)
    memory.lastError = messageOf(error)
    const status = (error as HttpError)?.status
    if (status === 401 || status === 403) {
      memory.retryAt = startedAt + REFUSED_RETRY_MS
    } else if (status) {
      memory.failures += 1
      memory.retryAt =
        startedAt + Math.min(GATE_BACKOFF.base * 2 ** (memory.failures - 1), GATE_BACKOFF.cap)
    }
    // No status at all is a request that never reached Simkl — this machine
    // was offline. That is not Simkl saying no, and the next pass asks again.
    return { stamps: null, readAt: 0, error: memory.lastError }
  }
}

/**
 * One pass of the recurring watch-sync job.
 *
 * In the order things have to happen: the gate; the watchlists (which is
 * also where plan changes a service refused are retried); the history
 * decisions still queued; and last, if this backend has a review panel and
 * the films on either side moved, the diff that panel shows.
 */
export async function runWatchSync(deps: WatchSyncDeps, memory: WatchSyncMemory): Promise<void> {
  const { db } = deps
  // Who this pass is for, captured before the first wait. Switching profile
  // or Simkl account during it is ordinary, and the record written at the
  // end must not vouch for somebody else's library.
  const profile = db.activeProfile()
  const account = deps.account()
  const gate = await readGate(deps, memory, account)

  // Watchlists come in on the same schedule as history goes out. They are
  // both "make the local picture match the services", and giving them
  // separate timers would mean two independent things to reason about for
  // no benefit. Failures are swallowed inside the pull, per service.
  try {
    await pullPlannedGated(deps, gate)
  } catch (error) {
    deps.log('job:planned-sync', error)
  }
  if (!deps.account()) return

  // Owed, not polled: a decision made in a previous session that never
  // reached the services goes out whatever the gate said.
  await deps.flushPushes()

  // The diff exists for the review panel, and nothing else reads it. On a
  // backend whose interface never asks for that panel it would be two whole
  // libraries fetched for nobody.
  if (!deps.reviewAsked() || !gate.stamps) return
  if (db.activeProfile() !== profile || deps.account() !== account) return
  const key = stateKey(profile)
  const diffed = watchSyncStateFor(db.getCache(key, { allowExpired: true }), account).diffed
  // Films only, because the diff is: it compares the films watched here
  // with the films watched there, and an episode watched moves neither.
  // Both sides, because either can move alone. Read before the diff, like
  // the stamp: a film marked while it runs is then seen by the next pass.
  const local = localFilmsSignature(db.history())
  if (diffed && diffed.movies === gate.stamps.movies && diffed.local === local) return
  let fetched = false
  try {
    fetched = await deps.reconcile()
  } catch (error) {
    deps.log('job:watch-sync', error)
  }
  // A diff inside its cooldown, or served from the snapshot cache, says
  // nothing about these stamps: the record stays where it was and the next
  // pass asks again.
  if (!fetched) return
  if (db.activeProfile() !== profile || deps.account() !== account) return
  const state = watchSyncStateFor(db.getCache(key, { allowExpired: true }), account)
  state.diffed = { movies: gate.stamps.movies, local, at: deps.now() }
  db.putCache(key, state, STATE_TTL_MS, { durable: true })
}
