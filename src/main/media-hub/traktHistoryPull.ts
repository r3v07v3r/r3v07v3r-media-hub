// Trakt's watch history, brought in on its own as it changes.
//
// The "Import my Trakt library" button reads a whole account once: every
// page of /sync/history, every rating. That stays the way an account's past
// comes in. This is what comes after it: every half hour (the watch-sync
// job) and with every catch-up (launch, resume, focus), one small request
// to /sync/last_activities, and only when Trakt says a film or an episode
// was watched since the last pull, /sync/history from that pull onwards.
// Like the import it only adds, and files each viewing exactly where the
// import does (traktClient.ts's fileTraktPlays: an anime series under its
// merged show, at its season there).
//
// One rule it shares with the Import button, and one thing that is its own:
//
//  - A viewing already held here is skipped, not written again, and so is
//    one whose removal Trakt has not taken yet (un-marked here, the push
//    still on its way or failed and owed). The Import button leaves out the
//    same viewings (heldViewings). Every episode played here is pushed to
//    Trakt and comes back on the next pull stamped with Trakt's own time,
//    which would otherwise be recorded as a second play. The catch-up skips
//    Simkl's echo the same way (simklCatchUpRules.ts).
//  - With nothing on record for this profile and account (no import has
//    been run for it, and no pull), the first pass reads the account's
//    whole past once, through the import button's own path and with its
//    backup (traktClient.ts's importTraktLibrary), keeping the rule above:
//    a viewing already held here is skipped. Then it records Trakt's stamps
//    and the time, and history from then on arrives by itself. Somebody
//    who connects Trakt gets their history without pressing Import. An
//    import that finishes records its own start as where the pull carries
//    on from, so a pass after one never reads the whole account again. A
//    first pass that fails records nothing and is tried again later,
//    further apart each time (TraktImportFailures).
//
// Each pull reaches back a few days before the last one (OVERLAP_MS), for
// a viewing that reached Trakt late with an earlier date; a row already
// here costs nothing. A viewing Trakt is given with a date older than that
// (a history entry backdated by hand) is the import's to find.
//
// The dependencies are injected, as in simklCatchUp.ts and watchSync.ts,
// so the test drives a real temporary database with Trakt faked.

import type { ImportedPlay, LibraryChangeScope } from '../../shared/media-hub/types'
import type { MediaHubDatabase } from './database'
import { parseTraktActivities, parseTraktHistory, type TraktWatchedStamps } from './trakt'

const DAY = 24 * 60 * 60 * 1000

/** How far before the last pull each pull reaches back. */
export const OVERLAP_MS = 3 * DAY

/** The record of where the pull is. Losing it is not free: with no record
 *  the next pass reads the account's whole past again (see the header). */
const STATE_TTL_MS = 400 * DAY

export interface TraktPullState {
  /** settingsStore's Trakt account mark when written. */
  account: string
  /** The stamps the last pull was made under. Null after an import, which
   *  read no stamps: the next pass then always pulls. */
  stamps: TraktWatchedStamps | null
  /** ISO time the next pull reads from (Trakt's start_at). */
  since: string
}

export function traktPullKey(profile: string): string {
  return `trakt:history-pull:v1:${profile}`
}

/** The stored state, if it is a well-formed one for this account. */
export function traktPullStateFor(stored: unknown, account: string): TraktPullState | null {
  const value = stored as TraktPullState | null
  if (!value || typeof value !== 'object' || value.account !== account) return null
  if (typeof value.since !== 'string' || Number.isNaN(Date.parse(value.since))) return null
  const stamps = value.stamps
  const valid =
    stamps === null ||
    (stamps &&
      typeof stamps === 'object' &&
      (stamps.movies === null || typeof stamps.movies === 'string') &&
      (stamps.episodes === null || typeof stamps.episodes === 'string'))
  return valid ? { account, stamps, since: value.since } : null
}

function writeState(
  db: Pick<MediaHubDatabase, 'putCache'>,
  profile: string,
  state: TraktPullState
): void {
  db.putCache(traktPullKey(profile), state, STATE_TTL_MS, { durable: true })
}

/**
 * Records that this profile's history is in step with Trakt up to `atMs` —
 * called by the import once it has written, so the pull carries on from
 * there rather than from whenever it first ran.
 */
export function markTraktHistoryPulled(
  db: Pick<MediaHubDatabase, 'putCache'>,
  profile: string,
  account: string,
  atMs: number
): void {
  if (!account) return
  writeState(db, profile, { account, stamps: null, since: new Date(atMs).toISOString() })
}

/**
 * A first pass whose whole-account import failed, so the next ones wait.
 *
 * The import reads every page of the account's history and both ratings
 * lists before it can find out it has to refuse (the anime catalog still
 * being organised, Simkl unreachable for the anime lookups), and the pull
 * runs every half hour and with every catch-up. Without this an account
 * whose import keeps failing was read whole, up to 200 pages, on every one
 * of them. Per profile and account, like the pull's own record; the Import
 * button is not held back by it, and a pass that succeeds writes the pull's
 * record, after which this is never read again.
 */
export interface TraktImportFailures {
  account: string
  /** Failed first passes in a row. */
  failures: number
  /** When the last one began. Not when it gave up: the import reads for
   *  minutes before it fails, and the wait is counted from the pass. */
  at: number
}

export function traktImportFailuresKey(profile: string): string {
  return `trakt:history-pull-failures:v1:${profile}`
}

/** How long after its last failed pass began the first pass is tried again:
 *  the next half-hourly pass after one failure, which is what the usual
 *  cause (the anime catalog being organised for a few minutes) needs; six
 *  hours after two; a day after three or more. Twenty-five minutes rather
 *  than thirty for the first, because the job comes round thirty minutes
 *  after its last run began, give or take its timer, and landing a moment
 *  short of the wait would put the retry off by another half hour. */
export function traktImportRetryAfterMs(failures: number): number {
  if (failures <= 1) return 25 * 60 * 1000
  if (failures === 2) return 6 * 60 * 60 * 1000
  return DAY
}

function importFailuresFor(stored: unknown, account: string): TraktImportFailures | null {
  const value = stored as TraktImportFailures | null
  if (!value || typeof value !== 'object' || value.account !== account) return null
  if (typeof value.failures !== 'number' || typeof value.at !== 'number') return null
  return value
}

/**
 * Whether Trakt's series rows can be filed now, from how their anime lookups
 * went (traktClient.ts's imdbToAnimeTargets): null when they can, otherwise
 * the reason, which the import and the pull throw so nothing is written or
 * recorded and the next pass tries again.
 *
 * Two things hold them back. Something resolved to anime while the anime
 * catalog is still being organised, so there is nothing to file it against.
 * Or a lookup nobody answered while a Simkl Client ID is set (Simkl down, or
 * refusing): that series may be anime, and filed now it would sit as a plain
 * series under its IMDb id for good, since only new history is read after.
 * With no Client ID there is nobody to wait for, so the rows are filed as
 * they come, as before.
 */
export function traktFilingHeldBack(lookups: {
  /** Series resolved to an anime. */
  resolved: number
  /** Series whose lookup nobody answered. */
  unanswered: number
  groupingReady: boolean
  /** Whether a Simkl Client ID is set, so a lookup can be answered at all. */
  resolverConfigured: boolean
}): string | null {
  if (lookups.resolved && !lookups.groupingReady) {
    return 'Your anime library is still being organised in the background — run the import again once it has finished.'
  }
  if (lookups.unanswered && lookups.resolverConfigured) {
    return 'Simkl could not be reached to tell which of your shows are anime, so nothing was imported. Try again shortly.'
  }
  return null
}

/** The key a viewing is held under here, as db.history() rows give it. */
function playKey(row: { id: string; season?: number | null; episode?: number | null }): string {
  return `${row.id}:${row.season ?? 'movie'}:${row.episode ?? 'movie'}`
}

/** What is held here, in playKey form: every viewing in `history`, and
 *  every one in `owed` (its removal not yet taken by Trakt). What the pull's
 *  first pass and the Import button leave out of an import. */
export function heldViewings(
  history: readonly { id: string; season?: number | null; episode?: number | null }[],
  owed: Iterable<string>
): Set<string> {
  return new Set([...history.map(playKey), ...owed])
}

/** The rows of `rows` whose viewing is not in `held` (playKey form). */
export function playsNotHeld<T extends ImportedPlay>(rows: T[], held: ReadonlySet<string>): T[] {
  return rows.filter((row) => !held.has(playKey(row)))
}

export interface TraktPullDeps {
  db: Pick<
    MediaHubDatabase,
    'activeProfile' | 'getCache' | 'putCache' | 'history' | 'importWatched'
  >
  /** settingsStore's Trakt account mark. Empty when Trakt is not connected. */
  account(): string
  /** GET /sync/last_activities, raw. */
  lastActivities(): Promise<unknown>
  /** Every page of /sync/history from `startAt` (Trakt's start_at), raw rows. */
  history(startAt: string): Promise<{ rows: unknown[]; truncated: boolean }>
  /** History keys (`id:season:episode`) whose removal Trakt has not taken
   *  yet, owed after a failed push or still on its way (tracking.ts's
   *  removalsHeldBack). Counted as held, so a viewing un-marked here is not
   *  filed back in from Trakt before the removal lands. Optional so a test
   *  that is not about it can leave it out. */
  removalsOwed?(): ReadonlySet<string>
  /** The import button's whole-account read and write (traktClient.ts's
   *  importTraktLibrary, its backup included), skipping the viewings `held`
   *  answers with when it is about to write. For a first pass with nothing
   *  on record. How many viewings and how many ratings it wrote: the import
   *  brings in the account's ratings too, and a pass that wrote only
   *  ratings must still tell the screens. */
  fullImport(held: () => ReadonlySet<string>): Promise<{ plays: number; ratings: number }>
  /** The viewings this pull wrote, for the record of what each pass merged
   *  (episodeSync.ts's noteArrivals). Optional so a test that is not about
   *  it can leave it out. */
  merged?(rows: ImportedPlay[]): void
  /** Where the import files Trakt's plays (traktClient.ts's fileTraktPlays). */
  file(rows: ImportedPlay[]): Promise<ImportedPlay[]>
  /** The backup before history rows are written (autoBackup.ts). */
  backup(): void
  /** Tell every open surface and the ranking what moved: 'history' for
   *  viewings, 'ratings' for scores (only the first pass's import writes
   *  those). */
  announce(scopes: LibraryChangeScope[]): void
  now(): number
  log(scope: string, error: unknown): void
}

export interface TraktPullReport {
  /** New viewings written. */
  plays: number
  /** Whether Trakt's history was read. */
  read: boolean
  error?: string
}

function sameStamps(a: TraktWatchedStamps | null, b: TraktWatchedStamps): boolean {
  return Boolean(a && a.movies === b.movies && a.episodes === b.episodes)
}

/**
 * One pull. Never throws; a failure is in the report and in the log, and
 * leaves the record where it was so the next pass asks again.
 */
export async function pullTraktHistory(deps: TraktPullDeps): Promise<TraktPullReport> {
  const { db } = deps
  // Whose history and whose Trakt this is, captured before the first wait
  // and checked after every one, as the import does.
  const profile = db.activeProfile()
  const account = deps.account()
  if (!account) return { plays: 0, read: false }
  const moved = (): boolean => db.activeProfile() !== profile || deps.account() !== account
  // What is held here now: every viewing in the history, and every one whose
  // removal Trakt has not taken yet. Read when about to write.
  const held = (): ReadonlySet<string> =>
    new Set([...db.history().map(playKey), ...(deps.removalsOwed?.() ?? [])])
  try {
    const startedAt = deps.now()
    const stamps = parseTraktActivities(await deps.lastActivities())
    if (moved()) return { plays: 0, read: false }
    const state = traktPullStateFor(
      db.getCache(traktPullKey(profile), { allowExpired: true }),
      account
    )
    if (!state) {
      // Nothing on record: the account's past, once, by the import's path.
      // A failure (the anime catalog still being organised, a profile
      // switch) throws to the catch below and records no position, so a
      // later pass tries again: the next one after a first failure, then
      // further apart (TraktImportFailures).
      const failuresKey = traktImportFailuresKey(profile)
      const failed = importFailuresFor(db.getCache(failuresKey), account)
      if (failed && deps.now() < failed.at + traktImportRetryAfterMs(failed.failures)) {
        return { plays: 0, read: false }
      }
      let imported: { plays: number; ratings: number }
      try {
        imported = await deps.fullImport(held)
      } catch (error) {
        const record: TraktImportFailures = {
          account,
          failures: (failed?.failures ?? 0) + 1,
          at: startedAt
        }
        db.putCache(failuresKey, record, 7 * DAY, { durable: true })
        throw error
      }
      if (moved()) return { plays: 0, read: true }
      writeState(db, profile, { account, stamps, since: new Date(startedAt).toISOString() })
      const scopes: LibraryChangeScope[] = []
      if (imported.plays > 0) scopes.push('history')
      if (imported.ratings > 0) scopes.push('ratings')
      if (scopes.length) deps.announce(scopes)
      return { plays: imported.plays, read: true }
    }
    if (sameStamps(state.stamps, stamps)) return { plays: 0, read: false }

    const since = new Date(Date.parse(state.since) - OVERLAP_MS).toISOString()
    const page = await deps.history(since)
    if (moved()) return { plays: 0, read: true }
    if (page.truncated) deps.log('trakt:pull', new Error('Stopped at the page limit.'))
    const parsed = parseTraktHistory(page.rows)
    const filed = await deps.file(parsed.rows)
    if (moved()) return { plays: 0, read: true }

    const fresh = playsNotHeld(filed, held())
    let plays = 0
    if (fresh.length) {
      deps.backup()
      plays = db.importWatched(fresh)
      deps.merged?.(fresh)
    }
    // From when this pull asked, so a viewing that lands during it is read
    // again next time rather than missed.
    writeState(db, profile, { account, stamps, since: new Date(startedAt).toISOString() })
    if (plays) deps.announce(['history'])
    return { plays, read: true }
  } catch (error) {
    deps.log('trakt:pull', error)
    return { plays: 0, read: false, error: (error as Error)?.message || String(error) }
  }
}
