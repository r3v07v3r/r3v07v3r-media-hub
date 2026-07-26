// Per-kind configuration for the Movies/Series/Anime category pages —
// the "configuration/data adapters" layer the integration spec asked for,
// so CategoryPage.tsx is one shared implementation driven by one of these
// three objects rather than three near-identical page components. Genre
// lists, filter fields, and search placeholders below are copied verbatim
// from the spec's own per-page lists — nothing here is invented.

import type { CategoryKind } from './categoryFilters'

export interface GenreBlob {
  id: string
  label: string
  /** Hue for the pill's halo/edge glow (see GenreBlobRow) — spread evenly
   *  across each page's own genre list so every page gets a distinct,
   *  deterministic rainbow rather than hand-picked colors per genre. */
  hue: number
}

/** Which of categoryFilters.ts's optional filter fields this kind exposes
 *  in the filter bar — movies get runtime, series get seasons+episode
 *  length, anime gets episodes+status (series also gets status). Exactly
 *  the field lists from the spec's per-page FILTER BAR sections. */
export interface CategoryFilterFields {
  runtime: boolean
  seasons: boolean
  episodeLength: boolean
  episodes: boolean
  status: boolean
}

export interface CategoryConfig {
  kind: CategoryKind
  /** Route path — must match App.tsx's <Route path> and NAV_ITEMS' href
   *  (mockData.ts) exactly; there is exactly one routing pattern in this
   *  app (HashRouter + react-router-dom) and this config doesn't invent a
   *  second one. */
  path: string
  label: string
  pluralLabel: string
  heroLabel: string
  searchPlaceholder: string
  icon: string
  genres: GenreBlob[]
  filterFields: CategoryFilterFields
  /** Rail headings, in display order. Movies/Series: Trending + New &
   *  Popular. Anime adds Top Rated (the spec's third anime-only rail). */
  rails: Array<{ key: 'trending' | 'newAndPopular' | 'topRated'; title: string }>
}

// Deterministic hue spread (avoids hand-authoring a hue per genre name
// while still giving every pill in a row a visually distinct color, same
// technique MoodBrowser's MOOD_CATEGORIES uses with hand-picked hues).
function genreBlobs(labels: string[]): GenreBlob[] {
  return labels.map((label, i) => ({
    id: label.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    label,
    hue: Math.round((360 / labels.length) * i)
  }))
}

export const MOVIES_CONFIG: CategoryConfig = {
  kind: 'movie',
  path: '/movies',
  label: 'Movies',
  pluralLabel: 'movies',
  heroLabel: 'Featured Movie',
  searchPlaceholder: 'Search movies…',
  icon: 'movies',
  genres: genreBlobs(['Action', 'Sci-Fi', 'Thriller', 'Drama', 'Comedy', 'Fantasy', 'Animation']),
  filterFields: {
    runtime: true,
    seasons: false,
    episodeLength: false,
    episodes: false,
    status: false
  },
  rails: [
    { key: 'trending', title: 'Trending' },
    { key: 'newAndPopular', title: 'New & Popular' }
  ]
}

export const SERIES_CONFIG: CategoryConfig = {
  kind: 'series',
  path: '/series',
  label: 'Series',
  pluralLabel: 'series',
  heroLabel: 'Featured Series',
  searchPlaceholder: 'Search series…',
  icon: 'tv',
  genres: genreBlobs(['Drama', 'Sci-Fi', 'Crime', 'Thriller', 'Fantasy', 'Comedy', 'Documentary']),
  filterFields: {
    runtime: false,
    seasons: true,
    episodeLength: true,
    episodes: false,
    status: true
  },
  rails: [
    { key: 'trending', title: 'Trending' },
    { key: 'newAndPopular', title: 'New & Popular' }
  ]
}

export const ANIME_CONFIG: CategoryConfig = {
  kind: 'anime',
  path: '/anime',
  label: 'Anime',
  pluralLabel: 'anime',
  heroLabel: 'Featured Anime',
  searchPlaceholder: 'Search anime…',
  icon: 'anime',
  genres: genreBlobs([
    'Shonen',
    'Fantasy',
    'Sci-Fi',
    'Action',
    'Slice of Life',
    'Mecha',
    'Romance'
  ]),
  filterFields: {
    runtime: false,
    seasons: false,
    episodeLength: false,
    episodes: true,
    status: true
  },
  rails: [
    { key: 'trending', title: 'Trending' },
    { key: 'newAndPopular', title: 'New & Popular' },
    { key: 'topRated', title: 'Top Rated' }
  ]
}

export const CATEGORY_CONFIGS: CategoryConfig[] = [MOVIES_CONFIG, SERIES_CONFIG, ANIME_CONFIG]
