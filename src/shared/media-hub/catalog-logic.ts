// Pure catalog/filtering/progress logic for the media-hub backend
// integration — a straight port of r3v07v3r-media-hub's src/shared.js (a
// dependency-free UMD module shared between that app's main and renderer
// processes) into this project's shared/ directory. Logic is preserved 1:1
// (translated to TypeScript, not redesigned) so it stays importable from
// both main-process code (relative import) and renderer code
// (`@shared/media-hub/catalog-logic`) with no Electron/Node dependency.

import { AiringState, CatalogItem, HistoryEntry, MediaKind } from './types'

export interface FilterCatalogOptions {
  includeGenres?: string[]
  excludeGenres?: string[]
  minRating?: number | string
  minYear?: number | string
  maxYear?: number | string
  watchMode?: 'both' | 'watched' | 'unwatched'
  history?: HistoryEntry[]
  sort?: 'rating' | 'year' | 'title' | string
}

export interface EpisodeWatchState {
  watchedKeys: Set<string>
  watchedCount: number
  total: number
  percent: number
  nextIndex: number
}

// Loose shape accepted by isItemWatched — every field the original app's
// callers might pass an item as (CatalogItem, TrackedItem, or a raw
// Simkl/IMDB-shaped record with imdbId/imdb_id) is optional here since the
// function only ever reads identity fields, never the rest of the item.
export type WatchableItem = Partial<CatalogItem> & {
  id?: string
  simklId?: number | string
  imdbId?: string
  imdb_id?: string
}

/**
 * Every id in a watch history, as one set.
 *
 * Exists because the identity check below is run in bulk — once per
 * catalog item, sometimes once per (catalog item, history entry) pair —
 * and rebuilding this per call is what made
 * rankPersonalizedRecommendations quadratic in the size of somebody's
 * history. See its own comment.
 */
function watchedIdSet(history: HistoryEntry[]): Set<string> {
  const ids = new Set<string>()
  for (const entry of history) ids.add(String(entry?.id))
  return ids
}

/** isItemWatched's identity rule, against an id set built once by the caller. */
function isWatchedById(item: WatchableItem, watchedIds: Set<string>): boolean {
  for (const value of [item?.id, item?.simklId, item?.imdbId, item?.imdb_id]) {
    if (value === undefined || value === null || value === '') continue
    if (watchedIds.has(String(value))) return true
  }
  return false
}

export function isItemWatched(item: WatchableItem, history: HistoryEntry[] = []): boolean {
  return isWatchedById(item, watchedIdSet(history))
}

export function filterCatalog(
  items: CatalogItem[],
  section = 'home',
  query = '',
  options: FilterCatalogOptions = {}
): CatalogItem[] {
  const q = query.trim().toLowerCase()
  const wanted = new Set((options.includeGenres || []).map((x) => String(x).toLowerCase()))
  const unwanted = new Set((options.excludeGenres || []).map((x) => String(x).toLowerCase()))
  const minRating = Number(options.minRating) || 0
  const minYear = Number(options.minYear) || 0
  const maxYear = Number(options.maxYear) || 9999
  const watchMode = options.watchMode || 'both'

  const visible = items.filter((item) => {
    const genres = (item.genres || []).map((x) => String(x).toLowerCase())
    const rating = Number.parseFloat(item.rating) || 0
    const year = Number.parseInt(item.year) || 0
    const watched = isItemWatched(item, options.history || [])
    const matchesQuery = !q || `${item.title} ${item.year}`.toLowerCase().includes(q)
    if (!matchesQuery) return false
    const inSection = section === 'home' || section === 'tracked' || item.type === section
    const watchOk = watchMode === 'both' || (watchMode === 'watched' ? watched : !watched)
    if (q) return inSection && watchOk
    return (
      inSection &&
      (!wanted.size || !genres.length || genres.some((x) => wanted.has(x))) &&
      !genres.some((x) => unwanted.has(x)) &&
      rating >= minRating &&
      (!minYear || year >= minYear) &&
      (!options.maxYear || year <= maxYear) &&
      watchOk
    )
  })

  if (options.sort === 'rating') {
    visible.sort((a, b) => (Number.parseFloat(b.rating) || 0) - (Number.parseFloat(a.rating) || 0))
  } else if (options.sort === 'year') {
    visible.sort((a, b) => (Number.parseInt(b.year) || 0) - (Number.parseInt(a.year) || 0))
  } else if (options.sort === 'title') {
    visible.sort((a, b) => String(a.title).localeCompare(String(b.title)))
  }
  return visible
}

// Number.isFinite(x)'s type signature requires `number`, but `history[].season`
// /`.episode` are typed `number | null` — this local wrapper matches
// Number.isFinite's own runtime semantics (false for anything not of type
// number, including null) while accepting the wider input type.
function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value)
}

// `Number(x) || fallback` would silently turn a real season/episode 0
// (season 0 is the specials convention) into the fallback — 0 is falsy in
// JS, not "missing". Only a genuinely non-numeric/absent value should fall
// back, so this checks finiteness instead of truthiness.
function numberOr(value: unknown, fallback: number): number {
  const n = Number(value)
  return Number.isFinite(n) ? n : fallback
}

function episodePositionKey(x: { season?: number; episode?: number; number?: number }): string {
  return `${numberOr(x.season, 1)}:${numberOr(x.episode ?? x.number, 1)}`
}

export function episodeWatchState(
  episodes: { season?: number; episode?: number; number?: number }[],
  history: HistoryEntry[],
  contentId: string
): EpisodeWatchState {
  const watched = new Set(
    (history || [])
      .filter(
        (x) =>
          String(x.id) === String(contentId) &&
          isFiniteNumber(x.season) &&
          isFiniteNumber(x.episode)
      )
      .map((x) => `${x.season}:${x.episode}`)
  )
  const watchedKeys = new Set(
    (episodes || []).map(episodePositionKey).filter((x) => watched.has(x))
  )
  const watchedCount = watchedKeys.size
  const total = (episodes || []).length
  return {
    watchedKeys,
    watchedCount,
    total,
    percent: total ? Math.round((watchedCount / total) * 100) : 0,
    nextIndex: (episodes || []).findIndex((x) => !watchedKeys.has(episodePositionKey(x)))
  }
}

export function airingStatus(
  item: { status?: string; videos?: { released?: string; firstAired?: string }[] } | undefined,
  now?: Date
): Exclude<AiringState, ''> {
  const nowDate = now || new Date()
  const raw = String(item?.status || '')
    .trim()
    .toLowerCase()
  if (raw) {
    if (raw === 'pilot') return 'upcoming'
    if (['current', 'returning series', 'in production'].includes(raw)) return 'airing'
    if (['finished', 'ended', 'canceled', 'cancelled'].includes(raw)) return 'ended'
    if (['upcoming', 'unreleased', 'planned'].includes(raw)) return 'upcoming'
  }
  const videos = Array.isArray(item?.videos) ? item.videos : []
  if (
    videos.some((v) => {
      const d = v.released || v.firstAired
      return d && new Date(d) > nowDate
    })
  ) {
    return 'airing'
  }
  if (
    videos.some((v) => {
      const d = v.released || v.firstAired
      if (!d) return false
      const days = (nowDate.getTime() - new Date(d).getTime()) / 86400000
      return days >= 0 && days <= 60
    })
  ) {
    return 'airing'
  }
  return 'unknown'
}

// ---------------------------------------------------------------------
// "Similar titles" ranking.
//
// This replaces what "Similar" used to mean in this app, which was the
// TMDB *collection* — i.e. the franchise. Asking for titles similar to
// "Dune" and being shown "Dune: Part Two" isn't a recommendation, it's a
// table of contents; and since most movies belong to no collection at
// all, the panel was empty far more often than not.
//
// Similar here means what a person means by it: same sort of thing —
// genre first, then era and standing. Kept pure and in shared/ so it can
// rank a locally-cached catalog with no API key and no network at all,
// which is what makes the panel work for everyone rather than only for
// people who have connected TMDB.
// ---------------------------------------------------------------------

/** The subject of the comparison. A CatalogItem satisfies this. */
export interface SimilarSource {
  id: string
  title: string
  genres?: string[]
  year?: string
}

/** Sequel/instalment markers — the word right after a shared title stem
 *  that tells you the two titles are the same story continuing, not two
 *  comparable stories. Roman numerals stop at X deliberately: past that
 *  the risk of eating a real word ("L", "C", "D", "M" are all valid
 *  numerals) outweighs the vanishingly rare 11th instalment. */
const SEQUEL_MARKERS = new Set([
  'part',
  'chapter',
  'episode',
  'volume',
  'vol',
  'ii',
  'iii',
  'iv',
  'v',
  'vi',
  'vii',
  'viii',
  'ix',
  'x'
])

function titleWords(value: string): string[] {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
}

/** Every dash variant a franchise stem might be written with. No `g` flag — `.test` on a global regex carries lastIndex between calls. */
const DASHES = /[-‐‑‒–—]/

/**
 * A title reduced to everything the sibling test actually reads.
 *
 * Split out so a title compared against many others is tokenized once
 * rather than once per comparison — see rankPersonalizedRecommendations,
 * which compares every remembered title against a bucket of candidates.
 */
interface TitleTokens {
  words: string[]
  hasDash: boolean
}

function titleTokens(value: string): TitleTokens {
  return { words: titleWords(value), hasDash: DASHES.test(String(value ?? '')) }
}

/** isLikelyFranchiseSibling over already-tokenized titles. */
function tokensAreFranchiseSiblings(a: TitleTokens, b: TitleTokens): boolean {
  const left = a.words
  const right = b.words
  if (!left.length || !right.length) return false
  let shared = 0
  while (shared < left.length && shared < right.length && left[shared] === right[shared]) {
    shared++
  }
  if (!shared) return false

  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (short.length !== long.length && shared === short.length) {
    if (short.length >= 2) return true
    const next = long[short.length]
    return SEQUEL_MARKERS.has(next) || /^\d+$/.test(next)
  }

  return shared >= 3 || (shared >= 2 && a.hasDash && b.hasDash)
}

/**
 * Whether two titles look like instalments of one franchise rather than
 * two separate works. Deliberately conservative — a false positive here
 * silently hides a legitimate suggestion, so a bare shared first word is
 * never enough on its own.
 *
 * A full title prefix is enough when the shared stem is at least two words
 * ("John Wick" / "John Wick Chapter 4") or the next word is a sequel
 * marker/number ("Dune" / "Dune Part Two"). Distinct titles can also share
 * a distinctive franchise stem, such as "Spider-Man: Homecoming" and
 * "Spider-Man: Far From Home"; accept that only for a hyphenated two-word
 * stem or a shared three-word stem. That keeps "Up" from swallowing "Up in
 * the Air" without giving ordinary one-word overlaps franchise status.
 */
export function isLikelyFranchiseSibling(a: string, b: string): boolean {
  return tokensAreFranchiseSiblings(titleTokens(a), titleTokens(b))
}

function genreOverlap(a: string[], b: string[]): number {
  if (!a.length || !b.length) return 0
  const set = new Set(a.map((x) => String(x).toLowerCase()))
  let shared = 0
  for (const genre of b) {
    if (set.has(String(genre).toLowerCase())) shared++
  }
  // Cosine-style rather than a raw count, so an item tagged with eight
  // genres doesn't outrank a genuinely closer match tagged with two just
  // by casting a wider net.
  return shared / Math.sqrt(a.length * b.length)
}

/**
 * Ranks `pool` by how similar each entry is to `source`, most similar
 * first. Requires at least one shared genre — with no genre in common
 * there's no honest claim of similarity left to make, and padding the
 * list out with whatever else is popular is worse than a short list.
 *
 * Genre agreement dominates; release era and audience rating only order
 * titles that are already comparable. Franchise instalments and the
 * source itself are excluded (see isLikelyFranchiseSibling).
 */
export function rankSimilarTitles(
  source: SimilarSource,
  pool: CatalogItem[],
  limit = 12
): CatalogItem[] {
  const sourceGenres = (source.genres || []).filter(Boolean)
  if (!sourceGenres.length) return []
  const sourceYear = Number.parseInt(String(source.year || ''), 10)

  const scored: { item: CatalogItem; score: number }[] = []
  for (const item of pool) {
    if (!item?.id || item.id === source.id) continue
    if (isLikelyFranchiseSibling(source.title, item.title)) continue
    const overlap = genreOverlap(sourceGenres, item.genres || [])
    if (overlap <= 0) continue

    const year = Number.parseInt(String(item.year || ''), 10)
    const era =
      Number.isFinite(sourceYear) && Number.isFinite(year)
        ? 1 / (1 + Math.abs(sourceYear - year) / 10)
        : 0
    const rating = Math.min(Math.max(Number.parseFloat(item.rating) || 0, 0), 10) / 10

    scored.push({ item, score: overlap * 10 + era * 1.5 + rating })
  }

  return scored
    .sort((a, b) => b.score - a.score || String(a.item.title).localeCompare(String(b.item.title)))
    .slice(0, Math.max(0, limit))
    .map((x) => x.item)
}

/** One ranked title, with the score that put it there — see rankPersonalizedRecommendationsScored. */
export interface ScoredRecommendation {
  item: CatalogItem
  score: number
}

/** Share of viewing by kind, 0..1, summing to 1. */
export type CadenceShares = Record<MediaKind, number>

/** What one person watches at one time of the week. */
export interface CadenceProfile {
  shares: CadenceShares
  /** Dated rows the slot was measured from — the confidence behind `shares`. */
  samples: number
}

const NO_SHARES: CadenceShares = { movie: 0, series: 0, anime: 0 }
const KINDS: MediaKind[] = ['movie', 'series', 'anime']

/**
 * How much of the week a slot covers. Four parts of the day, split
 * weekday/weekend, is eight buckets — coarse enough that a real history
 * fills them, fine enough to separate the patterns people actually have.
 * Local time throughout, deliberately: "what I watch on a Friday night" is
 * a fact about the person's evening, not about UTC.
 */
function timeSlot(when: Date): string {
  const hour = when.getHours()
  const part = hour < 6 ? 'late' : hour < 12 ? 'morning' : hour < 18 ? 'afternoon' : 'evening'
  const day = when.getDay()
  return `${day === 0 || day === 6 ? 'weekend' : 'weekday'}:${part}`
}

/**
 * Below this many dated rows in the current slot there is no pattern, only
 * a handful of evenings — which would reshape the row on the strength of
 * two or three viewings. Silence is the right answer for a new install,
 * and for anyone whose habits do not fall into slots at all.
 */
const MIN_SLOT_SAMPLES = 25

/**
 * How far the row may move towards the slot's own mix.
 *
 * Not all the way, on purpose. This project's own user data has weekday
 * mornings at 94% series; handing all eighteen slots to series would bury
 * genuinely better suggestions on the strength of what is, in the end, a
 * correlation with the clock. Half way keeps the row recognisably the
 * ranked one while making it look like the time of day it is.
 */
const CADENCE_STRENGTH = 0.5

/**
 * What this person tends to watch AT THIS TIME OF WEEK.
 *
 * Null when the current slot holds too little dated history to say
 * anything — see MIN_SLOT_SAMPLES.
 *
 * Undated rows are skipped rather than guessed at: Simkl's "all items"
 * sync omits last_watched_at for some movies (see HistoryEntry.watchedAt),
 * and dropping one costs a single sample where inventing a time for it
 * would quietly bias every slot.
 */
export function watchCadenceProfile(
  history: HistoryEntry[],
  now = new Date()
): CadenceProfile | null {
  const slot = timeSlot(now)
  const counts: Record<string, number> = {}
  let samples = 0

  for (const entry of history) {
    if (!entry?.watchedAt || !entry.type) continue
    const watchedAt = new Date(entry.watchedAt)
    if (Number.isNaN(watchedAt.getTime())) continue
    if (timeSlot(watchedAt) !== slot) continue
    counts[entry.type] = (counts[entry.type] || 0) + 1
    samples += 1
  }

  if (samples < MIN_SLOT_SAMPLES) return null

  const shares: CadenceShares = { ...NO_SHARES }
  for (const kind of KINDS) shares[kind] = (counts[kind] || 0) / samples
  return { shares, samples }
}

/**
 * How many row slots each kind gets: half what the ranking alone would
 * have shown, half what this person watches at this hour.
 *
 * Largest-remainder, capped by what is actually there — a kind with three
 * candidates cannot be handed eight slots, and whatever it cannot take
 * goes back to the kinds that can.
 */
function slotQuotas(
  queues: Map<MediaKind, ScoredRecommendation[]>,
  ranked: ScoredRecommendation[],
  shares: CadenceShares,
  count: number
): Map<MediaKind, number> {
  const available = Math.min(count, ranked.length)
  if (!available) return new Map(KINDS.map((kind) => [kind, 0]))

  // The other half of the blend: what the untouched ranking would have put
  // in the row.
  const baseCounts = new Map<MediaKind, number>(KINDS.map((kind) => [kind, 0]))
  for (const entry of ranked.slice(0, available)) {
    const kind = entry.item.type
    baseCounts.set(kind, (baseCounts.get(kind) || 0) + 1)
  }

  const targets = new Map<MediaKind, number>()
  for (const kind of KINDS) {
    const baseShare = (baseCounts.get(kind) || 0) / available
    targets.set(
      kind,
      ((1 - CADENCE_STRENGTH) * baseShare + CADENCE_STRENGTH * shares[kind]) * available
    )
  }

  const quotas = new Map<MediaKind, number>()
  let allocated = 0
  for (const kind of KINDS) {
    const capped = Math.min(Math.floor(targets.get(kind) || 0), queues.get(kind)?.length || 0)
    quotas.set(kind, capped)
    allocated += capped
  }

  // Whatever floor() and the availability caps left over, handed to the
  // kinds furthest below their target that still have candidates.
  while (allocated < available) {
    let best: MediaKind | null = null
    let bestGap = -Infinity
    for (const kind of KINDS) {
      if ((queues.get(kind)?.length || 0) <= (quotas.get(kind) || 0)) continue
      const gap = (targets.get(kind) || 0) - (quotas.get(kind) || 0)
      if (gap > bestGap) {
        bestGap = gap
        best = kind
      }
    }
    if (!best) break
    quotas.set(best, (quotas.get(best) || 0) + 1)
    allocated += 1
  }
  return quotas
}

/**
 * Builds the row: which titles it holds, and in what order, for the time
 * of day it is now.
 *
 * Two separate things happen here. The QUOTA decides how many of each kind
 * the row gets, and that is what lets a kind the ranking scores low
 * surface at all — something an added-on score bonus cannot do. Measured
 * on this project's own user data: series sit at ranks 25-39 of the stored
 * forty and never once entered the row, on weekday mornings that are 94%
 * series. No bonus small enough to be safe could lift them; a quota just
 * gives them the slots.
 *
 * Then the INTERLEAVE decides the order, spreading each kind through the
 * row in proportion to its quota rather than serving one kind and then the
 * next. A row of eighteen is scrolled, and the first few are what most
 * people ever see.
 *
 * Within a kind, base rank is preserved exactly. This never reorders two
 * titles of the same kind — it only decides how many of each appear, and
 * how they are spread.
 */
export function applyCadence(
  ranked: ScoredRecommendation[],
  profile: CadenceProfile | null,
  count: number
): CatalogItem[] {
  if (!profile) return ranked.slice(0, count).map((entry) => entry.item)

  const queues = new Map<MediaKind, ScoredRecommendation[]>(KINDS.map((kind) => [kind, []]))
  for (const entry of ranked) queues.get(entry.item.type)?.push(entry)

  const quotas = slotQuotas(queues, ranked, profile.shares, count)
  const taken = new Map<MediaKind, number>(KINDS.map((kind) => [kind, 0]))
  const total = [...quotas.values()].reduce((sum, n) => sum + n, 0)

  const row: CatalogItem[] = []
  while (row.length < total) {
    // The kind with the most of its share still owed, which spreads each
    // one evenly instead of in blocks. Ties go to the better-ranked head,
    // so the row still opens with the strongest suggestion available.
    let best: MediaKind | null = null
    let bestGap = -Infinity
    let bestScore = -Infinity
    for (const kind of KINDS) {
      const owed = (quotas.get(kind) || 0) - (taken.get(kind) || 0)
      if (owed <= 0) continue
      const head = queues.get(kind)?.[taken.get(kind) || 0]
      if (!head) continue
      if (owed > bestGap || (owed === bestGap && head.score > bestScore)) {
        bestGap = owed
        bestScore = head.score
        best = kind
      }
    }
    if (!best) break
    const index = taken.get(best) || 0
    const entry = queues.get(best)?.[index]
    if (!entry) break
    row.push(entry.item)
    taken.set(best, index + 1)
  }
  return row
}

// Home recommendations are ranked locally and deterministically. A small
// Ollama model can explain a shortlisted choice, but it should not decide
// watch-history or release ordering.
export interface PersonalizedRecommendationOptions {
  history: HistoryEntry[]
  preferredGenres?: string[]
  now?: Date
  /**
   * Titles carrying a resume bookmark nobody has come back to — started,
   * and left. The caller decides how long "left" is, because only it can
   * see the bookmark timestamps; see main/media-hub/recommendations.ts.
   *
   * Demoted rather than excluded. Somebody may well intend to come back,
   * and a suggestion row is the wrong place to make that decision for
   * them — but a title already tried and dropped should not be sitting
   * above one they have never seen.
   */
  abandonedIds?: ReadonlySet<string>
}

/**
 * What a title already started and left costs itself in the ranking.
 *
 * Sized against the other signals rather than picked: two genre matches
 * (see the scoring below) and well under the continuation boost, so it
 * pushes a dropped title down the row without burying it, and never
 * outranks "this is the next instalment of something you finished".
 */
const ABANDONED_PENALTY = 25

function releaseYear(item: Pick<CatalogItem, 'year'> | HistoryEntry): number | null {
  const year = Number.parseInt(String(item.year || ''), 10)
  return Number.isFinite(year) ? year : null
}

/** A pool entry with the two derived values the passes below would otherwise recompute per comparison. */
interface RankableItem {
  item: CatalogItem
  year: number | null
  tokens: TitleTokens
}

/**
 * The franchise pick's ordering: earliest release first, then title.
 * Strictly-earlier only, so equal entries keep whichever came first in
 * pool order — the same element the stable sort this replaced returned.
 */
function isEarlierInstalment(candidate: RankableItem, best: RankableItem): boolean {
  const byYear =
    (candidate.year || Number.MAX_SAFE_INTEGER) - (best.year || Number.MAX_SAFE_INTEGER)
  if (byYear !== 0) return byYear < 0
  return candidate.item.title.localeCompare(best.item.title) < 0
}

/**
 * Orders home suggestions using the catalog signals available locally:
 * chronological franchise continuations, genre affinity, recent releases
 * and rating. Franchise matching is conservative and title-based until the
 * broad catalog exposes canonical collection and continuity identifiers.
 *
 * The ranking is unchanged from the straightforward nested-loop version
 * this replaced; what changed is what that version cost on a real
 * library. It re-scanned the whole watch history inside a scan of the
 * whole catalog inside a scan of the whole watch history — every
 * isItemWatched call built a Set and walked the history again — so the
 * work grew with history² x catalog. Measured against this project's own
 * user data (3,104 history rows, 2,776 catalog titles): 87.7 SECONDS,
 * synchronously, on the Electron main process. That is the main thread
 * that owns the window, so Windows greys the app out as "Not Responding"
 * for the duration. It runs once per launch, from home:personalized,
 * which is why it read as the app hanging while the catalogue loaded.
 *
 * Three changes remove that, none of them altering the result:
 *
 *  - watched ids are collected once, so "has this been watched" is a set
 *    lookup instead of another walk of the history;
 *  - candidates are bucketed by type and first title word, because
 *    isLikelyFranchiseSibling cannot be true without a shared first word,
 *    so everything in another bucket is already known not to match;
 *  - identical (type, title, year) history rows are asked once — a series
 *    with sixty watched episodes is sixty rows asking one question.
 *
 * Same data, same output, 87.7s -> single-digit milliseconds.
 */
export function rankPersonalizedRecommendations(
  pool: CatalogItem[],
  options: PersonalizedRecommendationOptions
): CatalogItem[] {
  return rankPersonalizedRecommendationsScored(pool, options).map(({ item }) => item)
}

/**
 * rankPersonalizedRecommendations, keeping each title's score.
 *
 * The score exists so a caller can re-order a stored ranking later without
 * re-ranking it. main/media-hub/recommendations.ts stores these and adds
 * the watch-cadence boost at READ time, because that boost depends on what
 * time it is now — not on what time it was when the list was built. A list
 * ranked at 3am and read at 8pm would otherwise be recommending whatever
 * this person watches at 3am.
 */
export function rankPersonalizedRecommendationsScored(
  pool: CatalogItem[],
  {
    history,
    preferredGenres = [],
    now = new Date(),
    abandonedIds
  }: PersonalizedRecommendationOptions
): ScoredRecommendation[] {
  const preferred = new Set(preferredGenres.map((genre) => String(genre).toLowerCase()))
  const currentYear = now.getUTCFullYear()
  const watchedIds = watchedIdSet(history)

  // One pass over the pool serves both halves below. Pool order is kept,
  // which both the franchise tie-break and the final sort rely on.
  const unwatched: RankableItem[] = []
  const byTypeAndFirstWord = new Map<string, RankableItem[]>()
  for (const item of pool) {
    if (isWatchedById(item, watchedIds)) continue
    const entry: RankableItem = { item, year: releaseYear(item), tokens: titleTokens(item.title) }
    unwatched.push(entry)
    const firstWord = entry.tokens.words[0]
    if (firstWord === undefined) continue
    const key = `${item.type}\u0000${firstWord}`
    const bucket = byTypeAndFirstWord.get(key)
    if (bucket) bucket.push(entry)
    else byTypeAndFirstWord.set(key, [entry])
  }

  // Give the strong continuation boost only to the first later instalment.
  const nextFranchiseIds = new Set<string>()
  const askedAlready = new Set<string>()
  for (const watchedEntry of history) {
    const watchedTitle = watchedEntry?.title
    if (!watchedTitle) continue
    const watchedYear = releaseYear(watchedEntry)
    if (!watchedYear) continue
    // Every episode row of one series asks this same question, and the
    // answer depends on nothing but these three fields.
    const question = `${watchedEntry.type}\u0000${watchedYear}\u0000${watchedTitle}`
    if (askedAlready.has(question)) continue
    askedAlready.add(question)

    const sourceTokens = titleTokens(watchedTitle)
    const firstWord = sourceTokens.words[0]
    if (firstWord === undefined) continue
    const candidates = byTypeAndFirstWord.get(`${watchedEntry.type}\u0000${firstWord}`)
    if (!candidates) continue

    let next: RankableItem | null = null
    for (const candidate of candidates) {
      if ((candidate.year || 0) <= watchedYear) continue
      if (!tokensAreFranchiseSiblings(sourceTokens, candidate.tokens)) continue
      if (!next || isEarlierInstalment(candidate, next)) next = candidate
    }
    if (next) nextFranchiseIds.add(String(next.item.id))
  }

  return unwatched
    .map(({ item, year }) => {
      const genreMatches = (item.genres || []).filter((genre) =>
        preferred.has(String(genre).toLowerCase())
      ).length
      const recentReleaseBoost = year === currentYear ? 18 : year === currentYear - 1 ? 8 : 0
      const continuationBoost = nextFranchiseIds.has(String(item.id)) ? 100 : 0
      const rating = Math.min(Math.max(Number.parseFloat(item.rating) || 0, 0), 10)
      return {
        item,
        year,
        score:
          continuationBoost +
          recentReleaseBoost +
          genreMatches * 12 +
          rating -
          (abandonedIds?.has(String(item.id)) ? ABANDONED_PENALTY : 0)
      }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.year || 0) - (a.year || 0) ||
        a.item.title.localeCompare(b.item.title)
    )
    .map(({ item, score }) => ({ item, score }))
}

export function subtitlesInadequate(
  tracks: { language?: string; label?: string }[] | undefined
): boolean {
  const subs = Array.isArray(tracks) ? tracks : []
  if (!subs.length) return true
  return subs.every((t) => {
    const lang = String(t?.language || '')
      .trim()
      .toLowerCase()
    const label = String(t?.label || '')
      .trim()
      .toLowerCase()
    return !lang || lang === 'zxx' || /sign|song/.test(label)
  })
}
