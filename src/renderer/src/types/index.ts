// Core data model — see spec section 17. These shapes are intentionally
// framework-agnostic (plain interfaces, no class instances) so the mock
// data in src/data/mockData.ts can later be swapped for a real API client
// (REST, GraphQL, tRPC, whatever) without touching any component code —
// every component reads these interfaces, never the mock data shape
// directly.

export type MediaType = 'movie' | 'series' | 'episode' | 'live'

export interface MediaItem {
  id: string
  mediaType: MediaType
  /** The media-hub backend's own catalog kind ('movie' | 'series' | 'anime'), when this item came from there — see lib/mediaHub/adapters.ts. `mediaType` alone can't roundtrip this (it collapses 'anime' into 'series'), but PlaybackOverlay needs the real kind to resolve/play a stream correctly. Undefined for mock-data items, which never need it. */
  mediaKind?: 'movie' | 'series' | 'anime'
  title: string
  subtitle?: string
  description?: string
  posterUrl?: string
  backdropUrl?: string
  thumbnailUrl?: string
  logoUrl?: string
  /** BlurHash (or similar compact placeholder) for the primary artwork —
   *  not yet decoded/rendered anywhere, reserved for a future low-res
   *  preview blur while the real image loads. */
  artworkBlurhash?: string
  releaseYear?: number
  runtimeMinutes?: number
  genres: string[]
  moods?: string[]
  /** Top-billed performers, best-known first. Only ever present on a title
   *  whose full metadata has been resolved (the detail page) and whose
   *  credits a source could supply — see main/media-hub/credits.ts. Anime
   *  carries none: it credits voice actors per character, not per title. */
  cast?: string[]
  /** Directors for a film, creators for a show, studios for anime. Same availability as `cast`. */
  creators?: string[]
  /** Story-type labels — TMDB keywords, or AniList tags for anime. Distinct
   *  from `moods`, which are derived from genres by keyword map; these come
   *  from the source and describe what KIND of story a title is. */
  storyTags?: string[]
  communityRating?: number
  imdbRating?: number
  /** Rotten Tomatoes critic score, 0-100 — see adapters.ts's
   *  catalogItemToMediaItem. Movie/series only, and only when OMDb is
   *  connected and has a Rotten Tomatoes entry for this title; undefined
   *  otherwise (never a guessed value). */
  rottenTomatoesRating?: number
  matchPercentage?: number
  seasonNumber?: number
  episodeNumber?: number
  episodeTitle?: string
  /** Total season/episode counts for the whole series/anime (derived from
   *  the backend's `videos: Episode[]` list — see catalogItemToMediaItem)
   *  — distinct from seasonNumber/episodeNumber above, which track a
   *  specific in-progress episode, not the show's overall size. Undefined
   *  for movies and for mock data that never populated `videos`. */
  totalSeasons?: number
  totalEpisodes?: number
  /** The backend's raw status string for series/anime (e.g. "ongoing",
   *  "ended", "returning series") — CatalogItem.status passed through
   *  as-is, never inferred/guessed when the backend didn't provide one. */
  status?: string
  progressPercentage?: number
  remainingMinutes?: number
  watched: boolean
  /** Series/anime: every currently-aired episode has been watched (movies: same as `watched`) — see catalogItemToMediaItem's use of episodeWatchState. A show that's caught up but still airing counts as completed for filtering purposes; a show you're partway through does not. */
  completed: boolean
  /** Explicit "Not interested" (see ContextMenu's dislike action) — persisted locally, independent of watched/completed. */
  disliked: boolean
  inMyList: boolean
  playbackUrl?: string
  availableServices?: string[]
  /** Loading/error fallback ONLY — rendered while artwork is loading or
   *  when no posterUrl/backdropUrl/thumbnailUrl is available (or the
   *  image fails to load). Never used when a valid image exists; see
   *  ArtworkImage. `initials` is kept only for the rare places (avatars,
   *  ultra-small chips) that still want a 1-2 letter mark — primary
   *  artwork fallback now renders the full title, per spec. */
  artTint: [string, string]
  initials: string
}

export interface ContinueWatchingItem {
  media: MediaItem
  lastPlayedAt: string
  playbackPositionSeconds: number
  durationSeconds: number
  nextEpisodeId?: string
}

export interface Recommendation {
  media: MediaItem
  confidence: number
  reasons: string[]
  generatedAt: string
}

export interface MoodCategory {
  id: string
  label: string
  /** The human-facing promise for a single-mood collection page. */
  headline: string
  /** A concise cue for the kind of watch this mood is meant to surface. */
  description: string
  icon: string
  hue: number
  accent: string
}

export interface NavItem {
  id: string
  label: string
  icon: string
  href: string
}

export interface UserProfile {
  id: string
  name: string
  avatarInitial: string
  avatarTint: [string, string]
  isKid?: boolean
}

// No 'listening' member: the app has no voice input and cannot ask for a
// microphone (main/index.ts denies every permission request), so a state
// nothing could ever enter is not modelled here.
export type AssistantState = 'idle' | 'hover' | 'focused' | 'processing' | 'responding' | 'error'

// Global "what is the system doing right now" signal for the motion
// system (see AppStateContext's `uiActivity`) — every ambient/reactive
// animation reads this one value instead of re-deriving its own notion
// of activity from assistantState/playback/etc, so the whole interface
// agrees on when to look "busy" vs "idle".
export type UIActivityState =
  'idle' | 'hovering' | 'processing' | 'responding' | 'playing' | 'loading' | 'error'

export interface WeatherSnapshot {
  tempC: number
  condition: 'clear' | 'clouds' | 'rain' | 'storm' | 'snow'
  loading: boolean
}

export interface PerformanceSnapshot {
  cpu: number
  gpu: number
  ram: number
  netDownMbps: number
  netUpMbps: number
}

export interface AppNotification {
  id: string
  tone: 'info' | 'success' | 'warning' | 'error'
  message: string
  createdAt: number
  action?: {
    label: string
    run: () => void
  }
}

export type MatchTier = 'excellent' | 'good' | 'fair' | 'low'

export function matchTier(pct: number | undefined): MatchTier {
  if (pct === undefined) return 'low'
  if (pct >= 90) return 'excellent'
  if (pct >= 75) return 'good'
  if (pct >= 60) return 'fair'
  return 'low'
}
