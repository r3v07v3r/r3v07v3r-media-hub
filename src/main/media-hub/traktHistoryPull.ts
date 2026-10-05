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
// Two things it does that the import does not:
//
//  - A viewing already held here is skipped, not written again, and so is
//    one whose removal Trakt has not taken yet (un-marked here, the push
//    still on its way or failed and owed). Every
//    episode played here is pushed to Trakt and comes back on the next pull
//    stamped with Trakt's own time, which the import would record as a
//    second play. The catch-up skips Simkl's echo the same way
//    (simklCatchUpRules.ts).
//  - With nothing on record for this profile and account (no import has
//    been run for it, and no pull), the first pass reads the account's
//    whole past once, through the import button's own path and with its
//    backup (traktClient.ts's importTraktLibrary), keeping the rule above:
//    a viewing already held here is skipped. Then it records Trakt's stamps
//    and the time, and history from then on arrives by itself. Somebody
//    who connects Trakt gets their history without pressing Import. An
//    import that finishes records its own start as where the pull carries
//    on from, so a pass after one never reads the whole account again.
//
// Each pull reaches back a few days before the last one (OVERLAP_MS), for
// a viewing that reached Trakt late with an earlier date; a row already
// here costs nothing. A viewing Trakt is given with a date older than that
// (a history entry backdated by hand) is the import's to find.
//
// The dependencies are injected, as in simklCatchUp.ts and watchSync.ts,
// so the test drives a real temporary database with Trakt faked.

import type { ImportedPlay } from '../../shared/media-hub/types'
import type { MediaHubDatabase } from './database'
import { parseTraktActivities, parseTraktHistory, type TraktWatchedStamps } from './trakt'

const DAY = 24 * 60 * 60 * 1000

/** How far before the last pull each pull reaches back. */
export const OVERLAP_MS = 3 * DAY

/** The record of where the pull is; losing it costs a fresh start from now. */
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

/** The key a viewing is held under here, as db.history() rows give it. */
function playKey(row: { id: string; season?: number | null; episode?: number | null }): string {
  return `${row.id}:${row.season ?? 'movie'}:${row.episode ?? 'movie'}`
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
   *  on record. How many viewings it wrote. */
  fullImport(held: () => ReadonlySet<string>): Promise<{ plays: number }>
  /** The viewings this pull wrote, for the record of what each pass merged
   *  (episodeSync.ts's noteArrivals). Optional so a test that is not about
   *  it can leave it out. */
  merged?(rows: ImportedPlay[]): void
  /** Where the import files Trakt's plays (traktClient.ts's fileTraktPlays). */
  file(rows: ImportedPlay[]): Promise<ImportedPlay[]>
  /** The backup before history rows are written (autoBackup.ts). */
  backup(): void
  /** Tell every open surface and the ranking that history moved. */
  announce(): void
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
      // switch) throws to the catch below and records nothing, so the next
      // pass tries again. See the header.
      const imported = await deps.fullImport(held)
      if (moved()) return { plays: 0, read: true }
      writeState(db, profile, { account, stamps, since: new Date(startedAt).toISOString() })
      if (imported.plays) deps.announce()
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
    if (plays) deps.announce()
    return { plays, read: true }
  } catch (error) {
    deps.log('trakt:pull', error)
    return { plays: 0, read: false, error: (error as Error)?.message || String(error) }
  }
}
