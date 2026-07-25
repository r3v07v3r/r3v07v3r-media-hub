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
  communityRating?: number
  imdbRating?: number
  matchPercentage?: number
  seasonNumber?: number
  episodeNumber?: number
  episodeTitle?: string
  progressPercentage?: number
  remainingMinutes?: number
  watched: boolean
  completed: boolean
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

export type AssistantState =
  'idle' | 'hover' | 'focused' | 'listening' | 'processing' | 'responding' | 'error'

// Global "what is the system doing right now" signal for the motion
// system (see AppStateContext's `uiActivity`) — every ambient/reactive
// animation reads this one value instead of re-deriving its own notion
// of activity from assistantState/playback/etc, so the whole interface
// agrees on when to look "busy" vs "idle".
export type UIActivityState =
  'idle' | 'hovering' | 'listening' | 'processing' | 'responding' | 'playing' | 'loading' | 'error'

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
}

export type MatchTier = 'excellent' | 'good' | 'fair' | 'low'

export function matchTier(pct: number | undefined): MatchTier {
  if (pct === undefined) return 'low'
  if (pct >= 90) return 'excellent'
  if (pct >= 75) return 'good'
  if (pct >= 60) return 'fair'
  return 'low'
}
