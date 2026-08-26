// The Home dashboard's suggestion row, ranked ahead of time and stored, so
// opening the app is a read rather than a computation.
//
// Why this exists: home:personalized used to rank the whole catalog against
// the whole watch history on the launch path, which put two things in front
// of Home showing anything — the ranking itself, and the catalog crawl
// feeding it. The ranking is fast now (see catalog-logic.ts's
// rankPersonalizedRecommendations, and the 87-second stall its rewrite
// removed), but the crawl is not, and cannot be: a cold anime catalog is a
// two-thousand-title walk of Kitsu that measured 20.6 SECONDS on this
// project's own machine. Home was waiting all of it out for a row of
// eighteen suggestions it could have had immediately.
//
// So the ranking leaves the launch path. A background job (see
// backgroundJobs.ts) ranks, keeps the top STORED_COUNT, and writes the
// result here; a launch reads that one row back and serves from it, and
// touches no network at all on the way.
//
// The freshness trade that makes is deliberate, and it is NOT the same
// trade for every field. An ORDERING a few hours old is fine — it is a
// suggestion, not a fact. A list still offering something the person
// finished last night is not fine, and would be the kind of bug that makes
// a recommendation row feel broken. So the two are separated:
//
//   - the RANKING is stored, and allowed to age;
//   - the EXCLUSIONS (watched / in My List / not interested) are re-applied
//     live on every read, against id sets that cost microseconds to check.
//
// Stale order, never stale membership.

import type { CatalogItem, HistoryEntry } from '../../shared/media-hub/types'
import { MEDIA_HUB_CHANNELS } from '../../shared/media-hub/ipc-channels'
import {
  applyCadence,
  buildTasteProfile,
  rankPersonalizedRecommendationsScored,
  watchCadenceProfile,
  type ScoredRecommendation
} from '../../shared/media-hub/catalog-logic'
import { ratingWeight } from '../../shared/media-hub/rating'
import { creditsFor } from './credits'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { sendToRenderer } from './rendererBridge'
import type { TaskPriority } from './taskScheduler'

/**
 * Where the ranked list lives. Bump whenever the ranking changes shape or
 * meaning.
 *
 * A stored list is the output of one particular version of
 * rankPersonalizedRecommendations, and nothing in the row records which.
 * Keying by version is what stops a build that changed the scoring from
 * serving the previous version's ordering back for hours, out of a cache
 * nobody thought to clear.
 */
const STORE_KEY_PREFIX = 'recommendations:v2'

/**
 * Where one profile's ranked list lives.
 *
 * KEYED BY PROFILE, because the ranking is built from that profile's history,
 * ratings and taste. catalog_cache is not itself profile-scoped — it holds
 * facts about titles, not about people — so a single fixed key meant that
 * switching profiles served the previous one's taste-ranked titles and
 * preferred genres until the shared row happened to be rebuilt, potentially
 * hours later.
 */
export function storeKey(profileId: string = getDatabase().activeProfile()): string {
  return `${STORE_KEY_PREFIX}:${profileId}`
}

/**
 * How many ranked titles are kept.
 *
 * More than the row shows, on purpose. The stored ranking is filtered
 * live on every read (see the file header), so a person who watches five
 * of their suggestions between two rebuilds must not be left with a short
 * row until the next one. The surplus is the buffer that absorbs that;
 * below SERVED_COUNT survivors the read reports a miss and the caller
 * ranks live instead of showing a stub.
 */
export const STORED_COUNT = 40

/** How many the Home row actually shows — unchanged from what home:personalized always returned. */
export const SERVED_COUNT = 18

/**
 * How long a stored list stays readable. Long, because the age that
 * matters is REBUILD_AFTER_MS below — this one only exists so a list from
 * a genuinely abandoned install eventually stops being served.
 *
 * Read with `allowExpired` regardless: an ordering from last month still
 * beats making somebody wait out a catalog crawl to see a row of
 * suggestions, and the read schedules its own replacement anyway.
 */
const STORE_TTL_MS = 30 * 24 * 60 * 60 * 1000

/** Past this, a read still serves what it found but asks for a rebuild on the way past. */
const REBUILD_AFTER_MS = 6 * 60 * 60 * 1000

interface StoredRecommendations {
  /**
   * Ranked best-first, already excluding what was watched/tracked/disliked
   * AT BUILD TIME, and each carrying the score that put it there.
   *
   * The scores are what let the read re-order this list for the time of
   * day without re-ranking it — see readStoredRecommendations. A list
   * built at 3am and read at 8pm must not still be arranged around what
   * this person watches at 3am.
   */
  entries: ScoredRecommendation[]
  builtAt: number
  /** The genre affinity this ranking was produced from, so what is served and what explains it agree. */
  preferredGenres: string[]
}

/**
 * The three id sets a stored ranking has to be re-checked against.
 *
 * Passed in rather than read here, because every caller already has them
 * — home:personalized builds all three from rows it has just read, and
 * making this reach for them again would be a second pass over the whole
 * watch history for an answer already sitting in the caller's scope.
 */
export interface LiveExclusions {
  watchedIds: Set<string>
  trackedIds: Set<string>
  dislikedIds: Set<string>
}

/** Builds the exclusion sets from a history already in hand, plus the two small tables. */
export function liveExclusions(history: HistoryEntry[]): LiveExclusions {
  const db = getDatabase()
  return {
    watchedIds: new Set(history.map((entry) => String(entry.id))),
    trackedIds: new Set(db.tracked().map((item) => String(item.id))),
    dislikedIds: new Set(db.disliked().map((item) => String(item.id)))
  }
}

function keep(item: CatalogItem, exclusions: LiveExclusions): boolean {
  const id = String(item.id)
  return (
    !exclusions.watchedIds.has(id) &&
    !exclusions.trackedIds.has(id) &&
    !exclusions.dislikedIds.has(id)
  )
}

// Somebody has to ask for a rebuild, and it must not be this module: the
// job registry owns when work runs and under what pressure (see
// backgroundJobs.ts), and calling into it from here would put this module
// and that one in an import cycle — tracking.ts, which asks for rebuilds,
// is already imported BY the registry.
//
// So the request is a signal, and the registry subscribes to it. Nothing
// happens if nobody is listening, which is also what makes this callable
// from a unit test without starting a heartbeat.
let rebuildListener: (() => void) | null = null

/** Wires the job registry's "bring that job forward" to this module's requests. Call once, from startBackgroundJobs. */
export function onRebuildRequested(listener: (() => void) | null): void {
  rebuildListener = listener
}

/**
 * Asks for the suggestion list to be rebuilt soon — not now.
 *
 * Called from the handlers that change what the ranking would produce:
 * marking watched, saving to My List, marking not interested. Every one of
 * those is somebody waiting on a click, and none of them should pay for a
 * re-rank on the spot.
 *
 * "Soon" is the registry's next heartbeat, which is also what debounces
 * this for free: finishing six episodes in a row, or marking a whole
 * season, is one rebuild rather than six.
 */
export function requestRecommendationsRebuild(): void {
  rebuildListener?.()
}

/**
 * How long a resume bookmark has to sit untouched before the title counts
 * as started-and-left.
 *
 * A bookmark only exists between twenty seconds in and ninety per cent
 * through — savePlaybackPosition clears it either side of that — so every
 * row here is genuinely mid-title. Ten days is past "I'll finish it next
 * weekend" without being so long the signal never fires: on this project's
 * own user data, eight of thirteen bookmarks were over a week old and all
 * but one of those sat below 10% watched.
 */
const ABANDONED_AFTER_MS = 10 * 24 * 60 * 60 * 1000

/** Titles started and left — see ABANDONED_AFTER_MS. */
export function abandonedIds(now = Date.now()): Set<string> {
  try {
    return new Set(
      getDatabase().abandonedContentIds(new Date(now - ABANDONED_AFTER_MS).toISOString())
    )
  } catch (error) {
    logError('recommendations:abandoned', error)
    return new Set()
  }
}

/**
 * The stored ranking, re-filtered against what is true now and re-ordered
 * for what time it is now.
 *
 * Returns null — meaning "rank live instead" — when there is no stored
 * list, or when too little of it survives the live exclusions to fill the
 * row. Both cases ask for a rebuild on the way out, since both mean the
 * stored copy has stopped being good enough.
 */
export function readStoredRecommendations(
  exclusions: LiveExclusions,
  history: HistoryEntry[],
  now = new Date()
): { items: CatalogItem[]; preferredGenres: string[] } | null {
  let stored: StoredRecommendations | null = null
  try {
    // allowExpired: see STORE_TTL_MS. An old ordering is a far better
    // answer than a blank row, and this read schedules its replacement.
    stored = getDatabase().getCache<StoredRecommendations>(storeKey(), { allowExpired: true })
  } catch (error) {
    logError('recommendations:read', error)
    return null
  }
  if (!stored || !Array.isArray(stored.entries) || !stored.entries.length) {
    requestRecommendationsRebuild()
    return null
  }

  const surviving = stored.entries.filter((entry) => entry?.item && keep(entry.item, exclusions))
  if (surviving.length < SERVED_COUNT) {
    requestRecommendationsRebuild()
    return null
  }
  if (Date.now() - (stored.builtAt || 0) > REBUILD_AFTER_MS) requestRecommendationsRebuild()

  // The one part of the ranking that cannot be precomputed: it depends on
  // what time it is at the moment somebody looks, not on when the list was
  // built. Cheap enough to redo per read precisely because there are only
  // STORED_COUNT of them by this point.
  const items = applyCadence(surviving, watchCadenceProfile(history, now), SERVED_COUNT)

  return {
    items,
    preferredGenres: Array.isArray(stored.preferredGenres) ? stored.preferredGenres : []
  }
}

/**
 * Writes a freshly ranked list and, by default, tells the renderer it moved.
 *
 * Takes the ranking rather than producing it, so the cold path in
 * home:personalized — which has just ranked live because there was nothing
 * stored — can seed the store from that same work instead of ranking a
 * second time.
 *
 * `announce: false` is for exactly that caller. It is about to return this
 * list as its own answer, so announcing it would tell the renderer to
 * refetch a row it is in the middle of being handed — one wasted round
 * trip on every first launch, and a re-render of every consumer of the
 * Home feed to arrive at the data it already had.
 */
export function storeRecommendations(
  ranked: ScoredRecommendation[],
  preferredGenres: string[],
  {
    announce = true,
    profile = getDatabase().activeProfile()
  }: { announce?: boolean; profile?: string } = {}
): void {
  if (!ranked.length) return
  // A ranking belongs to the profile whose history produced it. Both callers
  // build it across awaits — a catalog read at minimum — so resolving the key
  // here would file A's taste-ranked titles under whoever is active by the
  // time the build lands. Discarded rather than mis-filed: a switch means
  // this ranking is about somebody who is no longer looking at it, and the
  // incoming profile's own rebuild is already the right answer.
  if (getDatabase().activeProfile() !== profile) return
  const payload: StoredRecommendations = {
    entries: ranked.slice(0, STORED_COUNT),
    builtAt: Date.now(),
    preferredGenres
  }
  try {
    getDatabase().putCache(storeKey(profile), payload, STORE_TTL_MS)
  } catch (error) {
    logError('recommendations:store', error)
    return
  }
  if (!announce) return
  // Only after the write succeeded. Telling the renderer to refetch a list
  // that did not actually change is a wasted round trip and a wasted
  // re-render of every consumer of the Home feed.
  sendToRenderer(MEDIA_HUB_CHANNELS.recommendationsChanged, {
    builtAt: payload.builtAt,
    count: payload.entries.length
  })
}

/**
 * Ranks the whole catalog and stores the result. The background job's
 * entire body, and the only thing in this module that touches the network.
 *
 * Catalogs are read UNFORCED: this is a re-rank, not a re-download. The
 * six-hourly catalog refresh (backgroundJobs.ts) owns when the underlying
 * rows are refetched, and forcing here would put a second full crawl —
 * two thousand anime titles among them — behind every episode somebody
 * finishes.
 */
export async function rebuildRecommendations(
  priority: TaskPriority = 'maintenance'
): Promise<number> {
  // Imported here rather than at the top of the file, for the reason
  // logger.ts spells out about electron: catalog.ts reaches ipcGuard, which
  // imports ipcMain as a VALUE, and that throws at import time wherever the
  // Electron binary is absent. Everything else in this module is pure
  // enough to unit test — the stored-list read, the live exclusions, the
  // rebuild request — and a top-level import here would take all of it down
  // with the one function that genuinely needs a catalog.
  const { catalogData } = await import('./catalog')
  const [movies, series, anime] = await Promise.all(
    (['movie', 'series', 'anime'] as const).map((kind) =>
      catalogData(kind, false, priority).catch(() => [] as CatalogItem[])
    )
  )
  const pool = [...movies, ...series, ...anime]
  // Nothing to rank from. Deliberately leaves whatever is already stored
  // in place: a catalog that is momentarily unreachable is not a reason to
  // replace a working list with an empty one.
  if (!pool.length) return 0

  const db = getDatabase()
  // Captured before the catalog reads above have been consumed and before the
  // ranking below — see storeRecommendations on why the write cannot resolve
  // it for itself.
  const profile = db.activeProfile()
  const history = db.history()
  const exclusions = liveExclusions(history)
  const preferredGenres = db.preferredGenres(4)

  // What this person keeps coming back to, learned from the credits of
  // what they have actually watched — see credits.ts. Both sides are read
  // from cache only: whatever the background enrichment pass has covered
  // so far is what this run gets, and an install where it has covered
  // nothing yet ranks exactly as it did before credits existed.
  // Each watched title's credits, paired with what the person thought of it.
  // An unrated title weighs 1, so a library nobody has rated builds exactly
  // the profile it built before ratings existed — see ratingWeight.
  const scores = db.ratings()
  const watchedCredits = creditsFor(history.map((entry) => String(entry.id)))
  const taste = buildTasteProfile(
    [...watchedCredits].map(([id, credits]) => ({
      credits,
      weight: ratingWeight(scores.get(id))
    }))
  )
  const candidates = pool.filter((item) => keep(item, exclusions))
  const credits = creditsFor(candidates.map((item) => String(item.id)))

  const ranked = rankPersonalizedRecommendationsScored(candidates, {
    history,
    preferredGenres,
    abandonedIds: abandonedIds(),
    credits,
    taste
  })

  if (!ranked.length) return 0

  storeRecommendations(ranked, preferredGenres, { profile })
  return Math.min(ranked.length, STORED_COUNT)
}
