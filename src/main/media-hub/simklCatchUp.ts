// Bringing the phone and TV app up to date with what was watched elsewhere.
//
// The desktop app learns of a disagreement with Simkl through its review
// panel, and somebody decides. The phone and TV app have no such panel and
// nobody to ask: they open, and Continue Watching should already know about
// the episode watched on the laptop last night. So this pass runs unattended
// whenever the lite UI asks — on launch, on resume — and it only ever adds:
// the watchlist pull, then Simkl's watched history taken into the local
// record, then the shows Simkl says are being watched followed here.
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
  | 'activeProfile'
  | 'getCache'
  | 'putCache'
  | 'history'
  | 'tracked'
  | 'track'
  | 'untrack'
  | 'isTracked'
  | 'importWatched'
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
  /** One kind's /sync/all-items payload, raw. */
  library(kind: SimklLibraryKind): Promise<unknown>
  /** The watchlist pull, behind the gate this pass has just read
   *  (watchSync.pullPlannedGated): Simkl's lists are fetched only if they
   *  moved since they were last read, by this pass or the half-hourly job. */
  syncPlanned(gate: SimklGate): Promise<{ added: number; removed: number }>
  /** Ids whose un-plan is still owed to a service (watchlists.idsAwaitingRemoval). */
  awaitingRemoval(): ReadonlySet<string>
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
  /** When the last pass finished. 0 before any has. */
  lastAt: number
  /** The connected accounts at the last pass, as one comparable string. */
  lastAccounts: string
  lastReport: CatchUpReport | null
  /** When this module last ran the watchlist pull. */
  lastPlannedAt: number
  activitiesBackoffUntil: number
  activitiesFailures: number
  /** Whose failures those were. A backoff earned by one account must not
   *  hold up the first pass of the account somebody has just linked. */
  activitiesBackoffAccount: string
  /** The Simkl account mark that was refused (401/403). No Simkl call is
   *  made again until the mark changes, which is somebody linking again. */
  signedOutAccount: string
  kindBackoffUntil: Record<SimklLibraryKind, number>
  kindFailures: Record<SimklLibraryKind, number>
}

export function newCatchUpMemory(): CatchUpMemory {
  return {
    inFlight: null,
    lastAt: 0,
    lastAccounts: '',
    lastReport: null,
    lastPlannedAt: 0,
    activitiesBackoffUntil: 0,
    activitiesFailures: 0,
    activitiesBackoffAccount: '',
    signedOutAccount: '',
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
  options: { force?: boolean } = {}
): Promise<CatchUpReport> {
  if (memory.inFlight) return memory.inFlight
  const marks = deps.connected()
  // Playback is the one thing nothing may compete with — a whole library
  // parsed on a phone's CPU mid-episode is a stutter somebody sees.
  if (deps.busy()) {
    return Promise.resolve(memory.lastReport ?? emptyReport(0, anyConnected(marks)))
  }
  const accounts = accountsKey(marks)
  if (
    !options.force &&
    memory.lastReport &&
    accounts === memory.lastAccounts &&
    deps.now() - memory.lastAt < FLOOR_MS
  ) {
    return Promise.resolve(memory.lastReport)
  }
  const run = catchUpPass(deps, memory, marks)
    .catch((error) => {
      // Never thrown to the caller: the screen that asked would only turn
      // it into an error over a row it can draw perfectly well without.
      deps.log('catch-up', error)
      const report = { ...emptyReport(deps.now(), anyConnected(marks)), error: messageOf(error) }
      memory.lastReport = report
      memory.lastAt = report.at
      memory.lastAccounts = accounts
      return report
    })
    .finally(() => {
      memory.inFlight = null
    })
  memory.inFlight = run
  return run
}

async function catchUpPass(
  deps: CatchUpDeps,
  memory: CatchUpMemory,
  marks: ConnectedAccounts
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
  if (account && memory.signedOutAccount === account) {
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
  const pullDue = startedAt - memory.lastPlannedAt >= PULL_INTERVAL_MS
  const simklMoved = kinds.length > 0 || (report.deferred && pullDue)
  if (simklMoved || ((marks.trakt || marks.mal) && pullDue)) {
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

    let payload: unknown
    try {
      payload = await deps.library(kind)
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
      watchedKeys: new Set(
        db.history().map((row) => `${row.id}:${row.season ?? 'movie'}:${row.episode ?? 'movie'}`)
      ),
      trackedIds: new Set(db.tracked().map((item) => String(item.id))),
      awaitingRemoval: deps.awaitingRemoval()
    }
    const plan = planCatchUp(resolved, local, seen, new Date(deps.now()))

    // Rule 8: a planned film now known to be watched comes off the plan.
    // Collected here, with the other local writes, so no wait can come
    // between a film being taken as watched and its leaving the plan: the
    // rule only fires for a NEW play, so one missed now is never offered
    // again and the film would stay planned and watched for good.
    const unplan: typeof plan.unplan = []
    try {
      report.plays += db.importWatched(plan.plays)
      // Followed locally and nowhere else. tracking.toggle would push a
      // plan add, and at Simkl that moves a show somebody is watching back
      // to plan to watch.
      for (const item of plan.follow) {
        db.track(item)
        report.followed += 1
      }
      for (const item of plan.unplan) {
        if (!db.isTracked(item.id)) continue
        db.untrack(item.id)
        unplanned += 1
        unplan.push(item)
      }
    } catch (error) {
      // importWatched is one transaction and repeatable, so a kind that
      // failed here is simply fetched and applied again later. Nothing is
      // recorded: a title marked seen whose rows never landed would be
      // skipped by every later pass.
      failKind(`catch-up:write:${kind}`, error)
      continue
    }

    state.seen = { ...state.seen, ...plan.seen }
    state.fetchedAt[stamp] = deps.now()
    if (complete) state.stamps[stamp] = stamps[stamp]
    try {
      db.putCache(key, state, STATE_TTL_MS, { durable: true })
      memory.kindFailures[kind] = 0
      memory.kindBackoffUntil[kind] = 0
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
  /** Ids already tried in this process — a title metadata cannot draw once
   *  will not draw on the next resume either. */
  tried: Set<string>
}

/** At most this many rows per pass: a first pull of a long list should not
 *  queue hundreds of metadata resolves behind the screen that asked. */
const ARTWORK_PER_PASS = 40

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
  for (const row of due) deps.tried.add(String(row.id))
  let filled = 0
  await mapWithLimit(due, async (row) => {
    const detail = await deps.metadata(row.type, String(row.id))
    if (!detail?.poster) return
    // Checked after the wait: the profile can change, and somebody can take
    // the title off their list while its artwork was loading.
    if (db.activeProfile() !== profile || !db.isTracked(row.id)) return
    db.track({ ...detail, id: row.id, type: row.type })
    filled += 1
  })
  if (filled) deps.announce()
  return filled
}

// ---------------------------------------------------------------------------
// The real thing.

const memory = newCatchUpMemory()
const artworkTried = new Set<string>()

/**
 * The catch-up against the real services and database, with this process's
 * memory. What the lite UI's tracking.catchUp reaches.
 */
export async function catchUpFromServices(
  options: { force?: boolean } = {}
): Promise<CatchUpReport> {
  // Lazily, for the reason in this file's header.
  const [simkl, watchlists, idBridge, seasons, settings, recommendations, bridge, queue, catalog] =
    await Promise.all([
      import('./simklClient'),
      import('./watchlists'),
      import('./idBridge'),
      import('./animeSeasons'),
      import('./settingsStore'),
      import('./recommendations'),
      import('./rendererBridge'),
      import('./titlePushQueue'),
      import('./catalog')
    ])
  const deps: CatchUpDeps = {
    db: getDatabase(),
    account: settings.simklAccountMark,
    connected: settings.trackingAccountMarks,
    // Small and asked for by a screen somebody is looking at.
    activities: () => simkl.simklActivities('visible'),
    // Large, and nobody is waiting on any one of them in particular.
    library: (kind) => simkl.simklLibrary(kind, 'background'),
    // Through the same record the half-hourly job keeps, so the two of
    // them read Simkl's lists once per change, not once each.
    syncPlanned: (gate) =>
      pullPlannedGated(
        {
          db: getDatabase(),
          account: settings.simklAccountMark,
          syncPlanned: (options) => watchlists.syncPlannedFromServices('background', options),
          now: () => Date.now()
        },
        gate
      ),
    awaitingRemoval: watchlists.idsAwaitingRemoval,
    lookupKitsu: (service, value) => idBridge.kitsuIdLookup(service, value, 'background'),
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
        tried: artworkTried
      }).catch((error) => logError('catch-up:artwork', error))
    },
    busy: () => currentPressure() === 'critical',
    now: () => Date.now(),
    log: logError
  }
  return runCatchUp(deps, memory, options)
}
