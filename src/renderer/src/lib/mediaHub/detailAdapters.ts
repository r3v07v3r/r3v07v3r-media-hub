// Per-kind configuration for the shared media detail page (MediaDetailPage
// + its section components) — same "configuration/data adapters" pattern
// categoryConfig.ts already uses for the Movies/Series/Anime category
// pages, so the detail page is one shared implementation driven by one of
// these three objects rather than a MovieDetailPage/SeriesDetailPage/
// AnimeDetailPage copy-pasted three times.

import type { MediaKind } from '@shared/media-hub/types'

export interface DetailAdapterConfig {
  kind: MediaKind
  /** Route segment this kind's category/detail pages live under — matches
   *  App.tsx's /movies, /series, /anime routes exactly. */
  path: 'movies' | 'series' | 'anime'
  label: string
  pluralLabel: string
  /** Series/anime have a season/episode structure (Next to Play, season
   *  selector, episode list); movies don't. Anime shares the series
   *  episodic UI rather than getting its own — the backend models both
   *  identically (CatalogItem.videos), and the reference spec's "seasons/
   *  arcs/cours/specials" distinction isn't something the backend actually
   *  exposes beyond season numbers (see Episode's shape) — presenting a
   *  richer arc/cour taxonomy here would be inventing structure the data
   *  doesn't have. */
  isEpisodic: boolean
}

export const MOVIE_DETAIL_CONFIG: DetailAdapterConfig = {
  kind: 'movie',
  path: 'movies',
  label: 'Movie',
  pluralLabel: 'movies',
  isEpisodic: false
}

export const SERIES_DETAIL_CONFIG: DetailAdapterConfig = {
  kind: 'series',
  path: 'series',
  label: 'Series',
  pluralLabel: 'series',
  isEpisodic: true
}

export const ANIME_DETAIL_CONFIG: DetailAdapterConfig = {
  kind: 'anime',
  path: 'anime',
  label: 'Anime',
  pluralLabel: 'anime',
  isEpisodic: true
}

export const DETAIL_CONFIGS: Record<MediaKind, DetailAdapterConfig> = {
  movie: MOVIE_DETAIL_CONFIG,
  series: SERIES_DETAIL_CONFIG,
  anime: ANIME_DETAIL_CONFIG
}
