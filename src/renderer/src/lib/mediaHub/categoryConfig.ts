// Per-kind configuration for the Movies/Series/Anime category pages —
// the "configuration/data adapters" layer the integration spec asked for,
// so CategoryPage.tsx is one shared implementation driven by one of these
// three objects rather than three near-identical page components. Filter
// fields and search placeholders below are copied verbatim from the
// spec's own per-page lists — nothing here is invented.

import type { CategoryKind } from './categoryFilters'

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
  searchPlaceholder: string
  icon: string
  filterFields: CategoryFilterFields
}

export const MOVIES_CONFIG: CategoryConfig = {
  kind: 'movie',
  path: '/movies',
  label: 'Movies',
  pluralLabel: 'movies',
  searchPlaceholder: 'Search movies…',
  icon: 'movies',
  filterFields: {
    runtime: true,
    seasons: false,
    episodeLength: false,
    episodes: false,
    status: false
  }
}

export const SERIES_CONFIG: CategoryConfig = {
  kind: 'series',
  path: '/series',
  label: 'Series',
  pluralLabel: 'series',
  searchPlaceholder: 'Search series…',
  icon: 'tv',
  filterFields: {
    runtime: false,
    seasons: true,
    episodeLength: true,
    episodes: false,
    status: true
  }
}

export const ANIME_CONFIG: CategoryConfig = {
  kind: 'anime',
  path: '/anime',
  label: 'Anime',
  pluralLabel: 'anime',
  searchPlaceholder: 'Search anime…',
  icon: 'anime',
  filterFields: {
    runtime: false,
    seasons: false,
    episodeLength: false,
    episodes: true,
    status: true
  }
}

export const CATEGORY_CONFIGS: CategoryConfig[] = [MOVIES_CONFIG, SERIES_CONFIG, ANIME_CONFIG]
