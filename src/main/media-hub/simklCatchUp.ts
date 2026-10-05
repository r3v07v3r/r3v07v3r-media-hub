// Bringing a device up to date with what was watched elsewhere.
//
// The phone and TV app open, and Continue Watching should already know about
// the episode watched on the laptop last night; the desktop should know
// about the one watched on the phone. So this pass runs unattended whenever
// an interface asks — the lite UI on launch and on resume, the desktop on
// launch and on window focus — and it only ever adds: the watchlist pull,
// then Simkl's watched history taken into the local record, then the shows
// Simkl says are being watched followed here. What it cannot settle by
// adding (Simkl saying a film here is not watched) is left to the desktop's
// review panel, which runs after it.
//
// What it decides to write is simklCatchUpRules.ts, which is pure and tested
// directly. This is the fetching, the ordering and the writing, and its
// dependencies are injected so the test can drive a whole pass against a
// real temporary database with canned payloads. Everything that reaches
// Electron (the Simkl client, the catalog, the IPC bridge) is imported
// lazily inside catchUpFromServices, for the reason recommendations.ts's
// rebuildRecommendations spells out: a top-level import of any of it throws
// wherever the Electron binary is absent, and would take the test with it.
//
// Three things it is careful about, because each was a way to do harm:
//
//  - Simkl suspends clients that poll the whole library without asking
//    /sync/activities first. Every library fetch is behind that gate — the
//    watchlist pull's Simkl lists included, see watchSync.ts — and when the
//    gate itself fails the pass fetches nothing and backs off.
//  - The pass awaits the network many times, and switching profile or
//    Simkl account during it is ordinary. After every wait it re-checks
//    both, and stops writing the moment either moved.
//  - Each kind (films, shows, anime) is committed on its own, and a kind's
//    activity stamp is only advanced once it has been applied in full. A
//    failure costs that kind a retry, never the others their progress, and
//    never a stamp that would make the next pass skip what was missed.

import type { CatalogItem, CatchUpReport, MediaKind } from '../../shared/media-hub/types'
import type { MediaHubDatabase } from './database'
import type { HttpError } from './httpClient'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { currentPressure, mapWithLimit } from './taskScheduler'
import {
  catchUpStateFor,
  kindsToFetch,
  librarySince,
  parseSimklActivities,
  parseSimklLibrary,
  planCatchUp,
  titleSignature,
  type CatchUpState,
  type ResolvedTitle,
  type SimklActivityStamps,
  type SimklLibraryKind,
  type SimklLibraryTitle
} from './simklCatchUpRules'
import { pullPlannedGated, type SimklGate } from './watchSync'

/** What the pass needs from the database — the real one, or a test's. */
export type CatchUpDb = Pick<
  MediaHubDatabase,
  'activeProfile' | 'getCache' | 'putCache' | 'history' | 'tracked' | 'applyCatchUp'
>

/** The services' account marks, as settingsStore's trackingAccountMarks
 *  gives them. An empty string is "not connected". */
export interface ConnectedAccounts {
  simkl: string
  trakt: string
  mal: string
}

export interface CatchUpDeps {
  db: CatchUpDb
  /** settingsStore's simklAccountMark — whose Simkl library this is. Empty
   *  when Simkl is not connected. */
  account(): string
  connected(): ConnectedAccounts
  /** GET /sync/activities, raw. Throws an HttpError (with `status`) on failure. */
  activities(): Promise<unknown>
  /** One kind's /sync/all-items payload, raw: whole when `since` is null,
   *  else only what changed after that activity stamp (Simkl's date_from). */
  library(kind: SimklLibraryKind, since: string | null): Promise<unknown>
  /** The watchlist pull, behind the gate this pass has just read
   *  (watchSync.pullPlannedGated): Simkl's lists are fetched only if they
   *  moved since they were last read, by this pass or the half-hourly job. */
  syncPlanned(gate: SimklGate): Promise<{ added: number; removed: number }>
  /** Ids whose un-plan is still owed to a service (watchlists.idsAwaitingRemoval). */
  awaitingRemoval(): ReadonlySet<string>
  /** History keys (`id:season:episode`) whose removal Simkl has not taken
   *  yet: owed after a failed push, still on its way, or a film the review
   *  panel ruled not watched (tracking.ts's removalsHeldBack). Treated as
   *  already held, so a viewing un-marked here is not taken back in from
   *  Simkl before the removal lands. Optional so a test that is not about it
   *  can leave it out. */
  removalsOwed?(): ReadonlySet<string>
  /** idBridge.kitsuIdLookup — `answered` is false when nobody could be asked. */
  lookupKitsu(
    service: 'mal' | 'anidb',
    value: number
  ): Promise<{ kitsuId: number | null; answered: boolean }>
  /** Where a raw Kitsu id belongs: the canonical show and its season there. */
  animeTarget(kitsuId: number): { id: string; season: number }
  /** Whether the anime catalog has been grouped (animeSeasons.animeGroupingReady). */
  animeReady(): boolean
  /** Rule 8's un-plan for a film just taken as watched (watchlists.unplanBecauseWatched). */
  unplanWatched(item: { id: string; type: MediaKind; title: string; year?: string }): Promise<void>
  /** Tell every open surface and the recommendation ranking that the library moved. */
  announce(): void
  /** Detached artwork fill for tracked rows that have none — see fillTrackedArtwork. */
  artwork(profile: string): void
  /** Trakt's history since the last pull (traktHistoryPull.ts), behind its
   *  own gate. Resolves to the viewings it wrote. Run only with Trakt
   *  connected; optional so a test that is not about it can leave it out. */
  traktHistory?(): Promise<number>
  /** True while something is playing: nothing may compete with it. */
  busy(): boolean
  now(): number
  log(scope: string, error: unknown): void
}

/**
 * What this process remembers between passes. Per process on purpose: a
 * backoff that outlived a restart would turn one bad hour into a day of a
 * phone that never catches up, and a restart is the natural thing to try.
 */
export interface CatchUpMemory {
  inFlight: Promise<CatchUpReport> | null
  /** The profile the running pass is for. */
  inFlightProfile: string
  /** When the last pass finished. 0 before any has. */
  lastAt: number
  /** The connected accounts at the last pass, as one comparable string. */
  lastAccounts: string
  /** The profile the last pass was for. History, the list and the stored
   *  state are all per profile, so a report about one says nothing about
   *  another. */
  lastProfile: string
  lastReport: CatchUpReport | null
  /** When this module last ran the watchlist pull. */
  lastPlannedAt: number
  activitiesBackoffUntil: number
  activitiesFailures: number
  /** Whose failures those were. A backoff earned by one account must not
   *  hold up the first pass of the account somebody has just linked. */
  activitiesBackoffAccount: string
  /** The Simkl account mark that was refused (401/403), and when. No Simkl
   *  call is made for it again until the mark changes, a pass is forced
   *  (somebody linking again), or REFUSED_RETRY_MS has passed. */
  signedOutAccount: string
  signedOutAt: number
  /** Whose pauses the two below are: `${account}|${profile}`. */
  kindBackoffOwner: string
  kindBackoffUntil: Record<SimklLibraryKind, number>
  kindFailures: Record<SimklLibraryKind, number>
}

export function newCatchUpMemory(): CatchUpMemory {
  return {
    inFlight: null,
    inFlightProfile: '',
    lastAt: 0,
    lastAccounts: '',
    lastProfile: '',
    lastReport: null,
    lastPlannedAt: 0,
    activitiesBackoffUntil: 0,
    activitiesFailures: 0,
    activitiesBackoffAccount: '',
    signedOutAccount: '',
    signedOutAt: 0,
    kindBackoffOwner: '',
    kindBackoffUntil: { movie: 0, show: 0, anime: 0 },
    kindFailures: { movie: 0, show: 0, anime: 0 }
  }
}

const MINUTE = 60 * 1000
const HOUR = 60 * MINUTE

/** A call this soon after the last pass answers with that pass. Launch,
 *  resume and a visibility change can all fire within a second of each
 *  other, and each is a reason to ask, not a reason to ask Simkl again. */
const FLOOR_MS = 2 * MINUTE
/** How often Trakt and MAL — which have no activities gate — are pulled. */
const PULL_INTERVAL_MS = 10 * MINUTE
const ACTIVITIES_BACKOFF = { base: 5 * MINUTE, cap: HOUR }
const KIND_BACKOFF = { base: 30 * MINUTE, cap: 6 * HOUR }
/** How long a kind that was fetched but could not be applied in full is
 *  left before it is fetched again. Its stamp has not advanced, so without
 *  a pause every resume would fetch it — and what held it up (an id lookup
 *  nobody could answer, a catalog being re-grouped) takes minutes to clear. */
const INCOMPLETE_RETRY_MS = 10 * MINUTE
/** How long a refused sign-in (401/403) is taken at its word before Simkl
 *  is asked again — the same six hours the half-hourly job waits
 *  (watchSync.ts), and for the same reason: one stray refusal must not end
 *  the syncing until somebody restarts the app. */
const REFUSED_RETRY_MS = 6 * HOUR
/** The state is the memory of what has been applied; losing it costs one
 *  full fetch of everything, so it is kept well past any plausible gap. */
const STATE_TTL_MS = 400 * 24 * HOUR

const STAMP_KEY: Record<SimklLibraryKind, keyof SimklActivityStamps> = {
  movie: 'movies',
  show: 'shows',
  anime: 'anime'
}

function stateKey(profile: string): string {
  return `simkl:catch-up:v1:${profile}`
}

function backoffFor(failures: number, policy: { base: number; cap: number }): number {
  return Math.min(policy.base * 2 ** Math.max(0, failures - 1), policy.cap)
}

function accountsKey(marks: ConnectedAccounts): string {
  return `${marks.simkl}|${marks.trakt}|${marks.mal}`
}

function anyConnected(marks: ConnectedAccounts): boolean {
  return Boolean(marks.simkl || marks.trakt || marks.mal)
}

function messageOf(error: unknown): string {
  return (error as Error)?.message || String(error)
}

function emptyReport(at: number, connected: boolean): CatchUpReport {
  return {
    at,
    connected,
    changed: false,
    plannedAdded: 0,
    plannedRemoved: 0,
    plays: 0,
    followed: 0,
    skipped: 0,
    deferred: false
  }
}

export interface CatchUpOptions {
  /** Skip the two-minute floor: somebody has just linked this device. */
  force?: boolean
  /** The desktop's: leave the Trakt and MyAnimeList watchlists, which have
   *  no gate to ask first, to the half-hourly watch-sync job, and read them
   *  here only along with Simkl's when Simkl's moved. A desktop window
   *  gains focus far more often than a phone resumes, and each pass would
   *  otherwise read both lists again on top of the job's own reads. */
  leaveListsToJob?: boolean
}

/**
 * One catch-up pass, or the answer of one that already ran or is running.
 *
 * Cheap to call often, and meant to be: a call while a pass is running
 * shares it, a call while something is playing or within two minutes of
 * the last pass is answered from memory. `force` skips the two-minute
 * floor (somebody has just linked this device) but never the other two.
 */
export function runCatchUp(
  deps: CatchUpDeps,
  memory: CatchUpMemory,
  options: CatchUpOptions = {}
): Promise<CatchUpReport> {
  const profile = deps.db.activeProfile()
  if (memory.inFlight) {
    // The pass running is for this profile: share it.
    if (memory.inFlightProfile === profile) return memory.inFlight
    // It is for another one. It stops writing the moment it notices the
    // switch, and its report is about somebody else's library — so this
    // call waits for it to end and then gets a pass of its own.
    return memory.inFlight.then(
      () => runCatchUp(deps, memory, options),
      () => runCatchUp(deps, memory, options)
    )
  }
  const marks = deps.connected()
  // What the last pass found, if it was about this profile at all.
  const last = memory.lastProfile === profile ? memory.lastReport : null
  // Playback is the one thing nothing may compete with — a whole library
  // parsed on a phone's CPU mid-episode is a stutter somebody sees.
  if (deps.busy()) return Promise.resolve(last ?? emptyReport(0, anyConnected(marks)))
  const accounts = accountsKey(marks)
  // Somebody has just linked this device, or a pass is being asked for by
  // name: the pauses that exist to space out idle passes do not apply.
  const fresh = Boolean(options.force) || accounts !== memory.lastAccounts
  if (!fresh && last && deps.now() - memory.lastAt < FLOOR_MS) return Promise.resolve(last)
  const run = catchUpPass(deps, memory, marks, fresh, options.leaveListsToJob === true)
    .catch((error) => {
      // Never thrown to the caller: the screen that asked would only turn
      // it into an error over a row it can draw perfectly well without.
      deps.log('catch-up', error)
      const report = { ...emptyReport(deps.now(), anyConnected(marks)), error: messageOf(error) }
      memory.lastReport = report
      memory.lastAt = report.at
      memory.lastAccounts = accounts
      memory.lastProfile = profile
      return report
    })
    .finally(() => {
      memory.inFlight = null
    })
  memory.inFlight = run
  memory.inFlightProfile = profile
  return run
}

async function catchUpPass(
  deps: CatchUpDeps,
  memory: CatchUpMemory,
  marks: ConnectedAccounts,
  /** A forced pass, or the first since the connected accounts changed. */
  fresh: boolean,
  /** CatchUpOptions.leaveListsToJob. */
  leaveListsToJob: boolean
): Promise<CatchUpReport> {
  const { db } = deps
  // Who this pass is FOR, captured before the first wait. Every write below
  // is checked against both — the precedent is traktClient's
  // importTraktLibrary, and the failure is the same one: one person's
  // library poured into whoever is active by the time the fetch returns.
  const profile = db.activeProfile()
  const account = deps.account()
  const moved = (): boolean => db.activeProfile() !== profile || deps.account() !== account

  const report = emptyReport(0, anyConnected(marks))
  let unplanned = 0
  const finish = (): CatchUpReport => {
    // Here rather than at the end of the loop, so a pass stopped part way
    // still announces what it did write before it stopped. The pull
    // announces its own changes; these are this pass's.
    if (report.plays || report.followed || unplanned) deps.announce()
    report.changed = Boolean(
      report.plannedAdded || report.plannedRemoved || report.plays || report.followed || unplanned
    )
    report.at = deps.now()
    memory.lastReport = report
    memory.lastAt = report.at
    memory.lastAccounts = accountsKey(marks)
    memory.lastProfile = profile
    // The pull adds titles as a name and a year, and a follow adds one with
    // even less. Detached: nothing on screen should wait for artwork.
    if (report.connected) deps.artwork(profile)
    return report
  }

  if (!report.connected) return finish()

  // --- the activities gate -------------------------------------------------
  const startedAt = deps.now()
  let stamps: SimklActivityStamps | null = null
  /** When the stamps were in hand — see SimklGate.readAt. */
  let stampsAt = 0
  if (account !== memory.activitiesBackoffAccount) {
    // The backoff belongs to the account that earned it. Linking again
    // gives a new token, and a forced pass straight after must reach Simkl
    // rather than sit out the last account's hour.
    memory.activitiesFailures = 0
    memory.activitiesBackoffUntil = 0
    memory.activitiesBackoffAccount = account
  }
  const owner = `${account}|${profile}`
  if (owner !== memory.kindBackoffOwner) {
    // The same for a kind's own pause, which is about one account's library
    // as one profile holds it. Left standing, a film fetch that timed out
    // three times for the last account would keep the next one's films off
    // this device for hours.
    memory.kindBackoffOwner = owner
    memory.kindFailures = { movie: 0, show: 0, anime: 0 }
    memory.kindBackoffUntil = { movie: 0, show: 0, anime: 0 }
  }
  // A refusal stands for this account, but not for ever and not against
  // somebody asking by name. Linking again hands over the desktop's own
  // token — the same one, if it was never really revoked — so "until the
  // account changes" could mean until the app is restarted, with Home
  // telling them to link again the whole time.
  const refused =
    Boolean(account) &&
    memory.signedOutAccount === account &&
    !fresh &&
    startedAt - memory.signedOutAt < REFUSED_RETRY_MS
  if (refused) {
    report.signedOut = true
  } else if (account && startedAt >= memory.activitiesBackoffUntil) {
    try {
      stamps = parseSimklActivities(await deps.activities())
      stampsAt = deps.now()
      memory.activitiesFailures = 0
      memory.activitiesBackoffUntil = 0
      memory.signedOutAccount = ''
    } catch (error) {
      deps.log('catch-up:activities', error)
      const status = (error as HttpError)?.status
      if (status === 401 || status === 403) {
        // The token was refused. Asking again on every resume would be a
        // request a minute to an account that has already said no.
        memory.signedOutAccount = account
        memory.signedOutAt = startedAt
        report.signedOut = true
      } else {
        // Never read as "everything changed": a revoked token or a spent
        // quota fails all-items as well, and Simkl suspends a client that
        // polls all-items without the gate. So nothing is fetched and
        // nothing is written for Simkl this pass.
        memory.activitiesFailures += 1
        memory.activitiesBackoffUntil =
          startedAt + backoffFor(memory.activitiesFailures, ACTIVITIES_BACKOFF)
        report.error = messageOf(error)
      }
    }
    if (moved()) return finish()
  }

  // --- which kinds are due ---------------------------------------------------
  const key = stateKey(profile)
  let state: CatchUpState | null = null
  let kinds: SimklLibraryKind[] = []
  if (stamps) {
    state = catchUpStateFor(db.getCache(key, { allowExpired: true }), account)
    kinds = kindsToFetch(state, stamps, startedAt)
    if (kinds.includes('anime') && !deps.animeReady()) {
      // Until the anime catalog is grouped, every Kitsu id resolves to
      // itself at season 1 — a merged franchise's later season would be
      // written where nothing reads it, and no later pass could move it.
      // Left alone, the stamp still differs next time, so it is fetched
      // once the grouping is done.
      kinds = kinds.filter((kind) => kind !== 'anime')
      report.deferred = true
    }
    // A kind whose last fetch failed waits out its own backoff; the others
    // are not held up by it.
    kinds = kinds.filter((kind) => startedAt >= memory.kindBackoffUntil[kind])
  }

  // --- the watchlist pull, BEFORE the history ------------------------------
  //
  // The pull refuses to plan anything with local history, so history must
  // not land first or a title planned at Simkl and watched elsewhere would
  // be refused here for a viewing this same pass wrote. And a planned film
  // since watched elsewhere is taken off the plan by the pull's own rule.
  //
  // The interval paces Trakt and MyAnimeList, which have no gate to ask
  // first. It does not apply to a fresh pass: an account linked a minute
  // after the last pull has a list nobody has read yet, and waiting out the
  // rest of ten minutes would leave Plan to Watch empty for it. On the
  // desktop (leaveListsToJob) the half-hourly job reads them instead, and
  // this pass reads them only when Simkl's moved.
  const pullDue = fresh || startedAt - memory.lastPlannedAt >= PULL_INTERVAL_MS
  const simklMoved = kinds.length > 0 || (report.deferred && pullDue)
  const ungatedDue = !leaveListsToJob && Boolean(marks.trakt || marks.mal) && pullDue
  if (simklMoved || ungatedDue) {
    memory.lastPlannedAt = startedAt
    try {
      const pulled = await deps.syncPlanned({
        stamps,
        readAt: stampsAt,
        error: report.error ?? (report.signedOut ? 'Simkl refused the sign-in.' : undefined)
      })
      report.plannedAdded = pulled.added
      report.plannedRemoved = pulled.removed
    } catch (error) {
      deps.log('catch-up:planned', error)
      report.error = messageOf(error)
    }
    if (moved()) return finish()
  }

  // --- each kind, committed on its own --------------------------------------
  for (const kind of kinds) {
    if (!state || !stamps) break
    const stamp = STAMP_KEY[kind]
    const failKind = (scope: string, error: unknown): void => {
      deps.log(scope, error)
      memory.kindFailures[kind] += 1
      memory.kindBackoffUntil[kind] =
        deps.now() + backoffFor(memory.kindFailures[kind], KIND_BACKOFF)
      report.error = messageOf(error)
    }

    // Whole the first time, and only what changed since the stored stamp
    // after that — see librarySince. Read before the fetch: the stored
    // stamp is about to be replaced by this pass's.
    const since = librarySince(state, kind, startedAt)
    let payload: unknown
    try {
      payload = await deps.library(kind, since)
    } catch (error) {
      failKind(`catch-up:library:${kind}`, error)
      if (moved()) return finish()
      continue
    }
    if (moved()) return finish()

    const parsed = parseSimklLibrary({ [stamp]: payload })
    report.skipped += parsed.dropped
    const seen = state.seen
    const changed = parsed.titles.filter((title) => titleSignature(title) !== seen[title.ref])

    // Resolve the changed titles to this app's ids. A title that cannot be
    // resolved is not recorded as seen, so it is looked at again next time
    // its kind is fetched; one whose lookup could not even be ASKED keeps
    // the whole kind's stamp where it was, so that next time comes.
    let complete = true
    const resolved: ResolvedTitle[] = []
    const anime: SimklLibraryTitle[] = []
    for (const title of changed) {
      if (title.kind === 'anime') {
        anime.push(title)
        continue
      }
      if (!title.imdb) {
        report.skipped += 1
        continue
      }
      resolved.push({
        title,
        id: title.imdb,
        type: title.kind === 'movie' ? 'movie' : 'series',
        animeSeason: null
      })
    }
    const kitsuIds = await mapWithLimit(anime, (title) => kitsuIdFor(deps, title))
    /** The kind is incomplete only because the catalog was un-grouped. */
    let heldForGrouping = false
    if (anime.length && !deps.animeReady()) {
      // Asked again, after the waits: the fetch and the lookups can take
      // minutes, and the catalog re-crawling in that time un-groups it
      // (catalog.ts stamps the flag false and drops the index in one step).
      // Resolved now, a merged franchise's later season would come back as
      // itself at season 1, and its rows, its follow and its `seen` entry
      // would all be written under an id nothing reads — for good, since
      // the stamp would advance. malSync's apply re-checks for the same
      // reason. Nothing here is resolved; the kind is fetched again later.
      complete = false
      heldForGrouping = true
      report.deferred = true
    } else {
      anime.forEach((title, index) => {
        // Null is a lookup that threw outright: nobody answered.
        const found = kitsuIds[index] ?? { kitsuId: null, answered: false }
        if (found.kitsuId) {
          const target = deps.animeTarget(found.kitsuId)
          resolved.push({ title, id: target.id, type: 'anime', animeSeason: target.season })
        } else if (found.answered) {
          report.skipped += 1
        } else {
          complete = false
        }
      })
    }

    // From here to the state write there is no wait, so nothing can move
    // underneath the plan between reading the local rows and writing.
    if (moved()) return finish()
    const local = {
      watchedKeys: new Set([
        ...db
          .history()
          .map((row) => `${row.id}:${row.season ?? 'movie'}:${row.episode ?? 'movie'}`),
        ...(deps.removalsOwed?.() ?? [])
      ]),
      trackedIds: new Set(db.tracked().map((item) => String(item.id))),
      awaitingRemoval: deps.awaitingRemoval()
    }
    const plan = planCatchUp(resolved, local, seen, new Date(deps.now()))

    // The viewings, the follows and the films coming off the plan (rule 8),
    // in ONE transaction. A follow and an un-plan are only offered for a
    // viewing that is new here, so viewings that landed without them would
    // never get them: the next pass finds every play already recorded and
    // offers nothing — a show never followed, a film planned and watched
    // for good.
    //
    // The follow is local and nowhere else. tracking.toggle would push a
    // plan add, and at Simkl that moves a show somebody is watching back to
    // plan to watch.
    let unplan: typeof plan.unplan = []
    try {
      const applied = db.applyCatchUp({
        plays: plan.plays,
        follow: plan.follow,
        unplan: plan.unplan.map((item) => item.id)
      })
      report.plays += applied.plays
      report.followed += plan.follow.length
      unplanned += applied.unplanned.length
      unplan = plan.unplan.filter((item) => applied.unplanned.includes(item.id))
    } catch (error) {
      // Nothing landed and nothing is recorded — a title marked seen whose
      // rows never landed would be skipped by every later pass — so the
      // kind is simply fetched and applied again later.
      failKind(`catch-up:write:${kind}`, error)
      continue
    }

    state.seen = { ...state.seen, ...plan.seen }
    state.fetchedAt[stamp] = deps.now()
    // Only a whole fetch that was applied in full counts as one: the weekly
    // whole read exists to pick up what incremental answers left out, and
    // one that could not place every title has not done that yet.
    if (!since && complete) state.fullAt[stamp] = deps.now()
    if (complete) state.stamps[stamp] = stamps[stamp]
    try {
      db.putCache(key, state, STATE_TTL_MS, { durable: true })
      memory.kindFailures[kind] = 0
      // An incomplete kind keeps its old stamp, so it is due again on the
      // very next pass. Nothing failed, but a lookup nobody could answer
      // will not have an answer by the next resume either. Not when the
      // catalog being re-grouped is what held it up: that is checked before
      // the fetch on every pass anyway, the interface asks again in three
      // minutes because the report says `deferred`, and a pause here would
      // outlast that retry and leave nothing to ask a fourth time.
      memory.kindBackoffUntil[kind] =
        complete || heldForGrouping ? 0 : deps.now() + INCOMPLETE_RETRY_MS
    } catch (error) {
      // The rows are in; only the note that they are was lost. That costs a
      // refetch which finds everything already here. Caught rather than
      // thrown out of the pass, so what landed is still announced and the
      // films it took off the plan are still reported to the services.
      failKind(`catch-up:state:${kind}`, error)
    }

    // The services' half of rule 8 — the local half is done above. Only
    // the pushes wait, and a profile or account that moved stops them.
    for (const item of unplan) {
      if (moved()) return finish()
      try {
        await deps.unplanWatched(item)
      } catch (error) {
        deps.log('catch-up:unplan', error)
      }
    }
    if (moved()) return finish()
  }

  // --- Trakt's history, after Simkl's -------------------------------------
  //
  // Same place in the order and the same reason: the watchlist pull above
  // has settled the plan. Trakt asks /sync/last_activities first, so on a
  // pass where nothing changed there this is one small request.
  if (marks.trakt && deps.traktHistory) {
    try {
      report.plays += await deps.traktHistory()
    } catch (error) {
      deps.log('catch-up:trakt', error)
    }
  }

  return finish()
}

/**
 * The Kitsu id a Simkl anime entry belongs to: the one in the payload, else
 * through its MAL id, else its AniDB id. `answered` is false only when a
 * lookup that could have found it could not be asked at all.
 */
async function kitsuIdFor(
  deps: CatchUpDeps,
  title: SimklLibraryTitle
): Promise<{ kitsuId: number | null; answered: boolean }> {
  if (title.kitsu) return { kitsuId: title.kitsu, answered: true }
  let answered = true
  for (const [service, value] of [
    ['mal', title.mal],
    ['anidb', title.anidb]
  ] as const) {
    if (!value) continue
    const found = await deps.lookupKitsu(service, value)
    if (found.kitsuId) return found
    if (!found.answered) answered = false
  }
  return { kitsuId: null, answered }
}

// ---------------------------------------------------------------------------
// Artwork for rows that arrived without any.

export interface ArtworkDeps {
  db: Pick<MediaHubDatabase, 'activeProfile' | 'tracked' | 'track' | 'isTracked' | 'indexByIds'>
  metadata(type: MediaKind, id: string): Promise<CatalogItem>
  announce(): void
  /** Ids not to ask about again in this process: being asked right now,
   *  answered (a title metadata cannot draw once will not draw on the next
   *  resume either), or given up on after ARTWORK_MAX_FAILURES. */
  tried: Set<string>
  /** How many times each id's lookup has failed outright in this process. */
  failures: Map<string, number>
}

/** At most this many rows per pass: a first pull of a long list should not
 *  queue hundreds of metadata resolves behind the screen that asked. */
const ARTWORK_PER_PASS = 40
/** A lookup that fails this many times in one process is left alone. A
 *  failure is usually the network, and is tried again; a title no source
 *  can resolve fails every time, and must not be asked for on every resume. */
const ARTWORK_MAX_FAILURES = 3

/**
 * Fills in posters for tracked rows that have none.
 *
 * A watchlist pull adds a title as a name and a year, and a follow from the
 * catch-up with even less — fine for the desktop's grids, which resolve
 * metadata anyway, and a row of blank tiles on the phone's Home. Only rows
 * the catalog index cannot draw either (home:personalized fills those from
 * the index itself), newest first, written under the row's OWN id: metadata
 * may answer under a different one, and the row must not move.
 */
export async function fillTrackedArtwork(profile: string, deps: ArtworkDeps): Promise<number> {
  const { db } = deps
  if (db.activeProfile() !== profile) return 0
  const bare = db.tracked().filter((row) => !row.poster)
  if (!bare.length) return 0
  const indexed = new Set(
    db
      .indexByIds(bare.map((row) => String(row.id)))
      .items.filter((item) => item.poster)
      .map((item) => String(item.id))
  )
  const due = bare
    .filter((row) => !indexed.has(String(row.id)) && !deps.tried.has(String(row.id)))
    .slice(0, ARTWORK_PER_PASS)
  // Marked before the lookups go out, so a second fill started while this
  // one is still waiting does not ask for the same rows.
  for (const row of due) deps.tried.add(String(row.id))
  let filled = 0
  await mapWithLimit(due, async (row) => {
    const id = String(row.id)
    let detail: CatalogItem
    try {
      detail = await deps.metadata(row.type, id)
    } catch {
      // Nobody answered, which says nothing about whether the title has
      // artwork. Left marked, one dropped connection would cost the card
      // its poster until the app was restarted — so it is let go again,
      // until it has failed often enough to be the title rather than the
      // network.
      const failures = (deps.failures.get(id) ?? 0) + 1
      deps.failures.set(id, failures)
      if (failures < ARTWORK_MAX_FAILURES) deps.tried.delete(id)
      return
    }
    if (!detail?.poster) return
    // Checked after the wait: the profile can change, and somebody can take
    // the title off their list while its artwork was loading.
    if (db.activeProfile() !== profile) {
      // Answered, but for a profile that is no longer the one to write to.
      // Let go, or the row would stay blank for the rest of the process once
      // somebody switched back.
      deps.tried.delete(id)
      return
    }
    if (!db.isTracked(row.id)) return
    db.track({ ...detail, id: row.id, type: row.type })
    filled += 1
  })
  if (filled) deps.announce()
  return filled
}

// ---------------------------------------------------------------------------
// The real thing.

const memory = newCatchUpMemory()

/** The last /sync/activities answer a real pass read, and for whom. */
let lastActivities: { account: string; at: number; payload: unknown } | null = null

/**
 * The /sync/activities answer the catch-up read for `account` within the
 * last `maxAgeMs`, if there is one. The desktop's launch check runs right
 * after the catch-up and asks the same question; reusing the answer saves
 * one of the 500 requests a day a linked phone shares.
 */
export function recentSimklActivities(
  account: string,
  maxAgeMs: number,
  now: number = Date.now()
): unknown {
  if (!lastActivities || !account || lastActivities.account !== account) return undefined
  return now - lastActivities.at <= maxAgeMs ? lastActivities.payload : undefined
}

/** Records an answer for recentSimklActivities. */
export function noteSimklActivities(account: string, payload: unknown, at: number): void {
  lastActivities = { account, at, payload }
}

const artworkTried = new Set<string>()
const artworkFailures = new Map<string, number>()

/**
 * The catch-up against the real services and database, with this process's
 * memory. What the lite UI's tracking.catchUp reaches.
 */
export async function catchUpFromServices(options: CatchUpOptions = {}): Promise<CatchUpReport> {
  // Lazily, for the reason in this file's header.
  const [
    simkl,
    watchlists,
    idBridge,
    seasons,
    settings,
    recommendations,
    bridge,
    queue,
    catalog,
    trakt,
    tracking
  ] = await Promise.all([
    import('./simklClient'),
    import('./watchlists'),
    import('./idBridge'),
    import('./animeSeasons'),
    import('./settingsStore'),
    import('./recommendations'),
    import('./rendererBridge'),
    import('./titlePushQueue'),
    import('./catalog'),
    import('./traktClient'),
    import('./tracking')
  ])
  const deps: CatchUpDeps = {
    db: getDatabase(),
    account: settings.simklAccountMark,
    connected: settings.trackingAccountMarks,
    // Everything this pass asks the network for is at `visible`: a screen
    // somebody is looking at asked for it, and Home is waiting on the rows
    // it fills. At `background` these requests stand down while anything
    // more urgent is queued — and on a fresh install that is the whole
    // first catalog crawl, a minute or more of it, so a phone that had just
    // been linked sat on "Updating…" until the crawl was done. They are a
    // handful of requests, and nothing runs at all while something plays.
    activities: async () => {
      const account = settings.simklAccountMark()
      const payload = await simkl.simklActivities('visible')
      noteSimklActivities(account, payload, Date.now())
      return payload
    },
    library: (kind, since) => simkl.simklLibrary(kind, 'visible', since),
    // Through the same record the half-hourly job keeps, so the two of
    // them read Simkl's lists once per change, not once each.
    syncPlanned: (gate) =>
      pullPlannedGated(
        {
          db: getDatabase(),
          account: settings.simklAccountMark,
          syncPlanned: (options) => watchlists.syncPlannedFromServices('visible', options),
          now: () => Date.now()
        },
        gate
      ),
    awaitingRemoval: watchlists.idsAwaitingRemoval,
    removalsOwed: () => tracking.removalsHeldBack('simkl'),
    lookupKitsu: (service, value) => idBridge.kitsuIdLookup(service, value, 'visible'),
    animeTarget: (kitsuId) => seasons.resolveAnimeGroupTarget(`kitsu:${kitsuId}`),
    animeReady: seasons.animeGroupingReady,
    // On the title's own push chain, like every other plan change — see
    // titlePushQueue.ts.
    unplanWatched: (item) =>
      queue.titlePushQueue.run(queue.titlePushKey(item), () =>
        watchlists.unplanBecauseWatched(item)
      ),
    announce: () => {
      recommendations.requestRecommendationsRebuild()
      bridge.notifyLibraryChanged('catch-up', 'history', 'planned')
    },
    artwork: (profile) => {
      void fillTrackedArtwork(profile, {
        db: getDatabase(),
        metadata: (type, id) => catalog.metadata(type, id, 'background'),
        announce: () => bridge.notifyLibraryChanged('catch-up', 'planned'),
        tried: artworkTried,
        failures: artworkFailures
      }).catch((error) => logError('catch-up:artwork', error))
    },
    traktHistory: async () =>
      (await trakt.pullTraktHistoryNow('visible', () => tracking.removalsHeldBack('trakt'))).plays,
    busy: () => currentPressure() === 'critical',
    now: () => Date.now(),
    log: logError
  }
  return runCatchUp(deps, memory, options)
}
