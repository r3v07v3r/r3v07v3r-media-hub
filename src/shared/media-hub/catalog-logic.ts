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
    (episodes || [])
      .map((x) => `${Number(x.season) || 1}:${Number(x.episode ?? x.number) || 1}`)
      .filter((x) => watched.has(x))
  )
  const watchedCount = watchedKeys.size
  const total = (episodes || []).length
  return {
    watchedKeys,
    watchedCount,
    total,
    percent: total ? Math.round((watchedCount / total) * 100) : 0,
    nextIndex: (episodes || []).findIndex(
      (x) => !watchedKeys.has(`${Number(x.season) || 1}:${Number(x.episode ?? x.number) || 1}`)
    )
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
