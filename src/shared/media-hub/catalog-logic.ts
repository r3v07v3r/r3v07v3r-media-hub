// Pure catalog/filtering/progress logic for the media-hub backend
// integration — a straight port of r3v07v3r-media-hub's src/shared.js (a
// dependency-free UMD module shared between that app's main and renderer
// processes) into this project's shared/ directory. Logic is preserved 1:1
// (translated to TypeScript, not redesigned) so it stays importable from
// both main-process code (relative import) and renderer code
// (`@shared/media-hub/catalog-logic`) with no Electron/Node dependency.

import {
  AiringState,
  CatalogItem,
  HistoryEntry,
  MediaKind,
  RecommendationReason,
  TitleCredits
} from './types'

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

/**
 * Is this a real, numbered episode of the show — as opposed to a special?
 *
 * Season 0 is where every source files specials, OVAs, recaps and
 * promotional clips (and where disambiguateVideos parks its synthetic
 * `unplayable` entries). They are shown in the episode grid under their
 * own Specials tab, and they can be played from there deliberately. What
 * they are never: part of the progress denominator, a reason a show is not
 * Complete, or the answer to a bare Play. Every rule that counts or
 * chooses episodes applies this one predicate — airedEpisodes,
 * playableEpisodesInOrder, continueWatchingList, the calendar window and
 * the index's episode counts — so a special is treated the same way on
 * every surface.
 */
export function isRegularEpisode(
  video: { unplayable?: boolean; season?: number | null } | undefined | null
): boolean {
  return Boolean(video) && !video?.unplayable && (video?.season ?? 1) > 0
}

/**
 * Has this episode actually come out yet?
 *
 * Cinemeta and TMDB both ship future-dated entries in `videos`, so "the next
 * one in the list" and "the next one you could actually watch" are different
 * questions for any show still airing. An episode with no date at all counts
 * as aired — that is a gap in the metadata, not evidence it is in the future,
 * and treating it as unaired would hide real episodes.
 *
 * THE ONE DEFINITION. adapters.ts's airedEpisodes (the denominator behind the
 * "Completed" badge and the detail page's progress) and nextEpisode.ts's
 * playableEpisodesInOrder (what a Play button starts) both apply it, so the
 * episode a card plays and the episode the progress bar counts cannot come
 * from two different ideas of "aired".
 */
export function hasAired(
  video: { released?: string } | undefined | null,
  now: number = Date.now()
): boolean {
  if (!video?.released) return true
  const at = new Date(video.released).getTime()
  // An unparseable date is a metadata gap, same as a missing one.
  return !Number.isFinite(at) || at <= now
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
  /**
   * The signal that contributed most to `score`, if any did — see
   * RecommendationReason. Absent when nothing about this person's viewing
   * picked it out, which is the ordinary case for a title carried purely by
   * its own rating.
   */
  reason?: RecommendationReason
}

/**
 * Tie-break order for which signal gets to explain a title.
 *
 * Only consulted when two contributions come out numerically equal, which
 * they can: three cast matches and a current-year release are both worth
 * 24 and 18 respectively today, and those weights move. Earlier is
 * stronger, ordered by how much the reason actually tells somebody —
 * "this continues something you finished" is a specific fact about them,
 * "it came out this year" is true of everyone.
 */
export const RECOMMENDATION_REASON_ORDER: readonly RecommendationReason['kind'][] = [
  'continues',
  'creator',
  'cast',
  'genre',
  'new'
]

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

/**
 * The names and story-type labels that keep coming up in what somebody
 * actually watches. Lowercased throughout, so matching is case-insensitive
 * without every comparison having to remember that.
 */
/**
 * One watched title's credits, and what the person thought of it.
 *
 * Bare credits are still accepted and mean "no opinion recorded", which
 * weighs 1 — the neutral value that makes an unrated library rank exactly as
 * it did before ratings existed. See shared/media-hub/rating.ts.
 */
export type WeightedCredits = TitleCredits | { credits: TitleCredits; weight: number }

export interface TasteProfile {
  cast: ReadonlySet<string>
  creators: ReadonlySet<string>
  keywords: ReadonlySet<string>
}

/**
 * How many of each are kept, and how often something has to appear before
 * it counts as a taste at all.
 *
 * The minimum is the important one. Watching a film once puts ten actors
 * and fifteen keywords into the tally, none of which is evidence of
 * anything — a person who has seen one Tarantino film does not thereby
 * like Tarantino. Requiring a second appearance is the difference between
 * a preference and a coincidence.
 */
const MIN_APPEARANCES = 2
const MAX_CAST_TASTE = 40
const MAX_CREATOR_TASTE = 15
const MAX_KEYWORD_TASTE = 30

/**
 * Keywords that describe how a title was MADE or MARKETED rather than what
 * it is about. TMDB's vocabulary mixes the two freely, and these carry no
 * information about whether somebody will enjoy something — every large
 * franchise film has a credits stinger.
 *
 * Deliberately short. The frequency ceiling below catches most noise on
 * its own and does it per person; this list is only for terms that are
 * useless even when rare.
 */
const PRODUCTION_KEYWORDS = new Set([
  'aftercreditsstinger',
  'duringcreditsstinger',
  'sequel',
  'prequel',
  'remake',
  'reboot',
  'live action remake',
  'woman director',
  'imax',
  'shot on imax'
])

/**
 * A keyword on more than this share of somebody's watched titles is not a
 * preference, it is a description of their library.
 *
 * This is what stops "sequel" or "shounen" — true of most of what this
 * person watches — from matching nearly every candidate and flattening the
 * signal into a constant. It tunes itself per person, which a fixed list
 * cannot: "superhero" is a real discriminator for one library and
 * meaningless in another.
 */
const KEYWORD_CEILING_SHARE = 0.25

/** Below this many enriched titles the ceiling above is measuring noise, so it is not applied at all. */
const MIN_TITLES_FOR_CEILING = 20

/**
 * The top `limit` names, by how much they are liked — but only among those
 * seen often enough to be a preference at all.
 *
 * TWO tallies, deliberately, because they answer two different questions.
 * `appearances` gates: has this name turned up in enough separate titles to
 * be evidence of anything (see MIN_APPEARANCES). `weights` ranks: of the
 * names that clear that bar, which does this person actually like — a
 * director in two films they both loved outranking one in three they merely
 * finished.
 *
 * Collapsing them into one weighted number would quietly undo the gate: a
 * single title rated 10 carries a weight of 2, which would clear a threshold
 * of 2 on its own and make one loved film enough to establish a "taste" —
 * exactly what MIN_APPEARANCES exists to prevent.
 */
function topNames(
  appearances: Map<string, number>,
  weights: Map<string, number>,
  limit: number
): Set<string> {
  return new Set(
    [...appearances]
      .filter(([, count]) => count >= MIN_APPEARANCES)
      .sort(
        (a, b) => (weights.get(b[0]) ?? 0) - (weights.get(a[0]) ?? 0) || a[0].localeCompare(b[0])
      )
      .slice(0, limit)
      .map(([name]) => name)
  )
}

/**
 * Builds a taste profile from the credits of everything somebody has
 * watched.
 *
 * Takes the credits rather than the titles, so this stays pure and the
 * question of where credits come from — and which titles have them yet —
 * belongs entirely to the caller.
 */
export function buildTasteProfile(watched: Iterable<WeightedCredits>): TasteProfile {
  const cast = new Map<string, number>()
  const creators = new Map<string, number>()
  const keywords = new Map<string, number>()
  const castWeight = new Map<string, number>()
  const creatorWeight = new Map<string, number>()
  const keywordWeight = new Map<string, number>()
  let titles = 0
  const bump = (
    counts: Map<string, number>,
    weights: Map<string, number>,
    values: string[] | undefined,
    weight: number
  ): void => {
    for (const value of values || []) {
      const name = String(value).trim().toLowerCase()
      if (!name) continue
      counts.set(name, (counts.get(name) || 0) + 1)
      weights.set(name, (weights.get(name) || 0) + weight)
    }
  }

  for (const entry of watched) {
    const credits = 'credits' in entry ? entry.credits : entry
    if (!credits) continue
    const weight = 'weight' in entry ? entry.weight : 1
    titles += 1
    bump(cast, castWeight, credits.cast, weight)
    bump(creators, creatorWeight, credits.creators, weight)
    bump(keywords, keywordWeight, credits.keywords, weight)
  }

  // Both filters are keyword-only. A performer or a director in most of
  // what somebody watches is the strongest preference there is; a LABEL in
  // most of what they watch is just what their library looks like.
  const ceiling = titles >= MIN_TITLES_FOR_CEILING ? titles * KEYWORD_CEILING_SHARE : Infinity
  const meaningful = new Map<string, number>()
  for (const [name, count] of keywords) {
    if (PRODUCTION_KEYWORDS.has(name) || count > ceiling) continue
    meaningful.set(name, count)
  }

  return {
    cast: topNames(cast, castWeight, MAX_CAST_TASTE),
    creators: topNames(creators, creatorWeight, MAX_CREATOR_TASTE),
    keywords: topNames(meaningful, keywordWeight, MAX_KEYWORD_TASTE)
  }
}

/**
 * What a shared name or label is worth, and how many of each can count.
 *
 * Capped per category rather than summed freely, because the categories
 * are not the same size: a title carries up to fifteen keywords and only
 * one or two creators, so uncapped keyword agreement would drown out a
 * director somebody follows. With these caps the whole affinity signal
 * tops out at 68 — a little above four genre matches, and comfortably
 * below the continuation boost, which should still win.
 */
const CAST_MATCH = 8
const CREATOR_MATCH = 10
const KEYWORD_MATCH = 6
const MAX_CAST_MATCHES = 3
const MAX_CREATOR_MATCHES = 2
const MAX_KEYWORD_MATCHES = 4

/** How many of `values` this person likes, and the first of them by name. */
interface Overlap {
  hits: number
  /**
   * The matched value AS WRITTEN in the credits, not the lowercased form the
   * comparison runs on — this is the half that ends up in front of somebody,
   * and "because you like zendaya" is not a sentence this app should produce.
   */
  first: string
}

const NO_OVERLAP: Overlap = { hits: 0, first: '' }

function overlap(values: string[] | undefined, liked: ReadonlySet<string>, cap: number): Overlap {
  if (!values?.length || !liked.size) return NO_OVERLAP
  let hits = 0
  let first = ''
  for (const value of values) {
    if (liked.has(String(value).trim().toLowerCase())) {
      hits += 1
      if (!first) first = String(value).trim()
    }
    if (hits >= cap) break
  }
  return hits ? { hits, first } : NO_OVERLAP
}

/**
 * What one candidate shares with this person's taste, kept apart rather
 * than summed.
 *
 * The parts are needed separately because they have to explain themselves
 * afterwards (see RecommendationReason): a single total says a title
 * matched, but not whether it matched on a director they follow or an
 * actor they keep watching, and those are different sentences.
 *
 * Keywords contribute to the score and deliberately never to a reason.
 * They are TMDB's internal vocabulary — "dystopia", "based on novel" — and
 * quoting one back reads as the machine talking about itself.
 */
interface Affinity {
  score: number
  cast: Overlap
  creators: Overlap
}

const NO_AFFINITY: Affinity = { score: 0, cast: NO_OVERLAP, creators: NO_OVERLAP }

/** What one title's cast, creators and story-type labels are worth against a taste profile. */
function affinityScore(credits: TitleCredits | undefined, taste: TasteProfile): Affinity {
  if (!credits) return NO_AFFINITY
  const cast = overlap(credits.cast, taste.cast, MAX_CAST_MATCHES)
  const creators = overlap(credits.creators, taste.creators, MAX_CREATOR_MATCHES)
  const keywords = overlap(credits.keywords, taste.keywords, MAX_KEYWORD_MATCHES)
  return {
    score: cast.hits * CAST_MATCH + creators.hits * CREATOR_MATCH + keywords.hits * KEYWORD_MATCH,
    cast,
    creators
  }
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
  /**
   * Cast, creators and story-type labels for the pool, by title id, and
   * the names this person keeps coming back to. Both or neither: a
   * profile with nothing to match against, or credits with no profile to
   * match them to, contributes nothing.
   *
   * Optional throughout, and empty for a long while on a new install —
   * the background enrichment pass fills them in over several sessions
   * (see main/media-hub/credits.ts). Ranking without them is exactly what
   * it was before they existed.
   */
  credits?: ReadonlyMap<string, TitleCredits>
  taste?: TasteProfile
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
    abandonedIds,
    credits,
    taste
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
  //
  // A map rather than a set: the boost is by far the strongest signal in
  // the ranking, so it is the one most often asked to explain itself, and
  // "because you watched something" is not an explanation. The value is the
  // title that earned it. First writer wins — the loop walks the history
  // newest-first, so a title following several things somebody watched is
  // attributed to the most recent of them, which is the one they remember.
  const nextFranchise = new Map<string, string>()
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
    if (next && !nextFranchise.has(String(next.item.id))) {
      nextFranchise.set(String(next.item.id), watchedTitle)
    }
  }

  return unwatched
    .map(({ item, year }) => {
      let genreMatches = 0
      let matchedGenre = ''
      for (const genre of item.genres || []) {
        if (!preferred.has(String(genre).toLowerCase())) continue
        genreMatches += 1
        // As the catalog spells it, not as the affinity set lowercased it.
        if (!matchedGenre) matchedGenre = String(genre).trim()
      }
      const recentReleaseBoost = year === currentYear ? 18 : year === currentYear - 1 ? 8 : 0
      const continuedFrom = nextFranchise.get(String(item.id))
      const continuationBoost = continuedFrom ? 100 : 0
      const rating = Math.min(Math.max(Number.parseFloat(item.rating) || 0, 0), 10)
      // Nothing at all until the background enrichment pass has been round
      // — see PersonalizedRecommendationOptions.credits.
      const affinity =
        credits && taste ? affinityScore(credits.get(String(item.id)), taste) : NO_AFFINITY
      return {
        item,
        year,
        score:
          continuationBoost +
          recentReleaseBoost +
          genreMatches * 12 +
          rating +
          affinity.score -
          (abandonedIds?.has(String(item.id)) ? ABANDONED_PENALTY : 0),
        // Built from the very numbers above, so what a card says and what
        // put it there cannot disagree. The rating is not among them: every
        // title has one, so it separates nothing and explains nothing.
        reason: strongestReason([
          { kind: 'continues', detail: continuedFrom ?? '', weight: continuationBoost },
          {
            kind: 'creator',
            detail: affinity.creators.first,
            weight: affinity.creators.hits * CREATOR_MATCH
          },
          { kind: 'cast', detail: affinity.cast.first, weight: affinity.cast.hits * CAST_MATCH },
          { kind: 'genre', detail: matchedGenre, weight: genreMatches * 12 },
          { kind: 'new', detail: year ? String(year) : '', weight: recentReleaseBoost }
        ])
      }
    })
    .sort(
      (a, b) =>
        b.score - a.score ||
        (b.year || 0) - (a.year || 0) ||
        a.item.title.localeCompare(b.item.title)
    )
    .map(({ item, score, reason }) => (reason ? { item, score, reason } : { item, score }))
}

/** One candidate explanation and what it was worth to the score. */
interface ReasonCandidate {
  kind: RecommendationReason['kind']
  detail: string
  weight: number
}

/**
 * The signal that contributed most, or nothing.
 *
 * Nothing is a real answer and a common one: a title carried by its own
 * rating alone matched nothing about this person, and inventing a reason
 * for it — "highly rated", true of half the catalog — would teach people
 * that the chips are decoration. A candidate with no evidence to point at
 * is dropped for the same reason, however much it scored.
 */
function strongestReason(candidates: ReasonCandidate[]): RecommendationReason | undefined {
  let best: ReasonCandidate | null = null
  for (const candidate of candidates) {
    if (candidate.weight <= 0 || !candidate.detail) continue
    if (
      !best ||
      candidate.weight > best.weight ||
      (candidate.weight === best.weight &&
        RECOMMENDATION_REASON_ORDER.indexOf(candidate.kind) <
          RECOMMENDATION_REASON_ORDER.indexOf(best.kind))
    ) {
      best = candidate
    }
  }
  return best ? { kind: best.kind, detail: best.detail } : undefined
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
