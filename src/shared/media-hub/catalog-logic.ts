// Pure catalog/filtering/progress logic for the media-hub backend
// integration — a straight port of r3v07v3r-media-hub's src/shared.js (a
// dependency-free UMD module shared between that app's main and renderer
// processes) into this project's shared/ directory. Logic is preserved 1:1
// (translated to TypeScript, not redesigned) so it stays importable from
// both main-process code (relative import) and renderer code
// (`@shared/media-hub/catalog-logic`) with no Electron/Node dependency.

import { AiringState, CatalogItem, HistoryEntry } from './types'

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

export function isItemWatched(item: WatchableItem, history: HistoryEntry[] = []): boolean {
  const ids = new Set(
    [item?.id, item?.simklId, item?.imdbId, item?.imdb_id]
      .filter((x) => x !== undefined && x !== null && x !== '')
      .map(String)
  )
  return history.some((entry) => ids.has(String(entry?.id)))
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

/**
 * Whether two titles look like instalments of one franchise rather than
 * two separate works. Deliberately conservative — a false positive here
 * silently hides a legitimate suggestion, so a bare shared first word is
 * never enough on its own.
 *
 * One title's words must be a prefix of the other's, AND either the
 * shared stem is at least two words ("John Wick" / "John Wick Chapter 4")
 * or the very next word is a sequel marker or a number ("Dune" / "Dune
 * Part Two"). That's what keeps "Up" from swallowing "Up in the Air"
 * while still catching the cases that actually annoy people.
 */
export function isLikelyFranchiseSibling(a: string, b: string): boolean {
  const left = titleWords(a)
  const right = titleWords(b)
  if (!left.length || !right.length) return false
  const [short, long] = left.length <= right.length ? [left, right] : [right, left]
  if (short.length === long.length) return false
  for (let i = 0; i < short.length; i++) {
    if (short[i] !== long[i]) return false
  }
  if (short.length >= 2) return true
  const next = long[short.length]
  return SEQUEL_MARKERS.has(next) || /^\d+$/.test(next)
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
