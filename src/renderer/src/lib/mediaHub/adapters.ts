// Maps the media-hub backend's own data model (CatalogItem/TrackedItem/
// ContinueWatchingEntry/HistoryEntry — see @shared/media-hub/types) onto
// this dashboard's pre-existing MediaItem/ContinueWatchingItem/
// Recommendation interfaces (src/renderer/src/types). Deliberately kept
// separate from both sides rather than merging the two type systems — the
// backend's field names mirror the ported CommonJS app's normalize
// functions (see that file's own header comment), and the frontend's
// shapes were designed independently around this dashboard's UI (spec
// section 17). This file is the one place that translates between them.

import type {
  CatalogItem,
  ContinueWatchingEntry,
  MediaKind,
  TrackedItem,
  TrackedItemEnriched
} from '@shared/media-hub/types'
import type { MediaItem, MediaType, Recommendation } from '@renderer/types'
import { initialsFromTitle, tintFromSeed } from './tint'

// MediaType has no 'anime' member (this dashboard's type model predates
// the media-hub integration) — anime titles render through the same
// episodic-series UI as a TV series, which is the closest fit (both carry
// season/episode-numbered `videos`). Not lossy for anything this dashboard
// currently renders: nothing branches on 'anime' specifically.
function toMediaType(kind: MediaKind): MediaType {
  return kind === 'anime' ? 'series' : kind
}

// The reverse of toMediaType, for building an outbound tracking payload
// from a MediaItem the user is acting on (My List toggle, mark watched).
// 'episode'/'live' have no catalog-kind equivalent (nothing in this
// dashboard currently tracks/plays either through the media-hub backend) —
// mapped to the closest harmless default rather than throwing, since a
// stray call here shouldn't crash the My List button.
function toMediaKind(type: MediaType): MediaKind {
  if (type === 'episode') return 'series'
  if (type === 'live') return 'movie'
  return type
}

/**
 * Minimal outbound payload for tracking:toggle / the `item` half of
 * tracking:mark-watched — only the fields the main process's
 * `TrackableItem`/`SimklPushItem` types actually read (id/type/title/
 * poster/year), not a full CatalogItem round-trip.
 */
export function mediaItemToTrackablePayload(media: MediaItem): {
  id: string
  type: MediaKind
  title: string
  poster: string
  year: string
} {
  return {
    id: media.id,
    type: toMediaKind(media.mediaType),
    title: media.title,
    poster: media.posterUrl ?? '',
    year: media.releaseYear ? String(media.releaseYear) : ''
  }
}

function parseRuntimeMinutes(runtime: string): number | undefined {
  const n = parseInt(runtime, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseYear(year: string): number | undefined {
  const n = parseInt(year, 10)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

function parseRating(rating: string): number | undefined {
  const n = Number(rating)
  return Number.isFinite(n) && n > 0 ? n : undefined
}

// The backend has no mood taxonomy at all (CatalogItem carries genres, not
// moods) — MoodBrowser's mood pills only mean something for MediaItems that
// have `moods` set, so real catalog items are heuristically tagged here by
// keyword-matching their genres against this dashboard's 7 mood categories
// (see mockData.ts's MOOD_CATEGORIES). This is a best-effort approximation,
// not real editorial mood tagging — a genre like "Drama" always maps to
// 'emotional' whether or not a given drama actually feels that way. An item
// can (and often does) match multiple moods, same as the hand-tagged mock
// catalog.
const GENRE_MOOD_KEYWORDS: Record<string, string[]> = {
  action: ['action', 'thrilling'],
  adventure: ['thrilling', 'action'],
  thriller: ['thrilling'],
  horror: ['thrilling'],
  mystery: ['thrilling', 'mind-bending'],
  crime: ['thrilling'],
  war: ['emotional'],
  history: ['emotional'],
  drama: ['emotional'],
  romance: ['emotional'],
  comedy: ['feel-good'],
  music: ['feel-good'],
  family: ['family', 'feel-good'],
  animation: ['family', 'feel-good'],
  kids: ['family'],
  fantasy: ['mind-bending', 'sci-fi'],
  sci: ['sci-fi', 'mind-bending'], // matches both "Sci-Fi" and "Science Fiction"
  documentary: ['mind-bending']
}

function genresToMoods(genres: string[]): string[] {
  const moods = new Set<string>()
  for (const genre of genres) {
    const key = genre.trim().toLowerCase()
    for (const [needle, tags] of Object.entries(GENRE_MOOD_KEYWORDS)) {
      if (key.includes(needle)) tags.forEach((tag) => moods.add(tag))
    }
  }
  return Array.from(moods)
}

export interface CatalogItemAdapterContext {
  /** ids currently tracked/saved (from tracking:list or home:personalized's `tracked`) — drives MediaItem.inMyList. */
  trackedIds?: Set<string>
  /** ids with at least one watched entry (from tracking:list's `history`) — drives MediaItem.watched/completed for catalog rows (Continue Watching uses its own richer completion signal, see continueWatchingEntryToItem). */
  watchedIds?: Set<string>
}

/** The single conversion every other adapter in this file builds on. */
export function catalogItemToMediaItem(
  item: CatalogItem,
  context: CatalogItemAdapterContext = {}
): MediaItem {
  const watched = context.watchedIds?.has(item.id) ?? false
  return {
    id: item.id,
    mediaType: toMediaType(item.type),
    mediaKind: item.type,
    title: item.title,
    description: item.description || undefined,
    posterUrl: item.poster || undefined,
    backdropUrl: item.background || undefined,
    logoUrl: item.logo || undefined,
    releaseYear: parseYear(item.year),
    runtimeMinutes: parseRuntimeMinutes(item.runtime),
    genres: item.genres,
    moods: genresToMoods(item.genres),
    communityRating: parseRating(item.rating),
    imdbRating: parseRating(item.rating),
    watched,
    completed: watched,
    inMyList: context.trackedIds?.has(item.id) ?? false,
    artTint: tintFromSeed(item.id || item.title),
    initials: initialsFromTitle(item.title)
  }
}

/** Tracked-item rows (Home's "tracked" list, My Stuff) — a narrower shape than CatalogItem but with the same identity fields. */
export function trackedItemToMediaItem(
  item: TrackedItem | TrackedItemEnriched,
  context: CatalogItemAdapterContext = {}
): MediaItem {
  return catalogItemToMediaItem(
    {
      id: item.id,
      title: item.title,
      type: item.type,
      poster: item.poster,
      background: item.background,
      logo: item.logo,
      year: item.year,
      description: item.description,
      rating: item.rating,
      runtime: item.runtime,
      genres: item.genres,
      videos: [],
      trailers: item.trailers
    },
    { ...context, trackedIds: new Set([...(context.trackedIds ?? []), item.id]) }
  )
}

/**
 * home:personalized's continueWatching entries are episode-level ("N of M
 * episodes watched, next up is SxxEyy") — the backend has no sub-episode
 * resume position (see HistoryEntry: it records *that* an episode was
 * watched, not a playback offset within it). `playbackPositionSeconds`/
 * `durationSeconds` are therefore synthesized from the season-level
 * progress fraction against a placeholder duration, just so the existing
 * progress-bar UI has consistent numbers to render — actually resuming
 * always starts the next unwatched episode from 0:00, it never seeks into
 * the middle of one.
 */
export function continueWatchingEntryToItem(entry: ContinueWatchingEntry) {
  const media = catalogItemToMediaItem(entry, { trackedIds: new Set([entry.id]) })
  const progressFraction = entry.totalCount > 0 ? entry.watchedCount / entry.totalCount : 0
  const durationSeconds = (media.runtimeMinutes ?? 45) * 60
  const completed = entry.totalCount > 0 && entry.watchedCount >= entry.totalCount

  return {
    media: {
      ...media,
      seasonNumber: entry.continueSeason,
      episodeNumber: entry.continueEpisode,
      progressPercentage: Math.round(progressFraction * 100),
      remainingMinutes: Math.max(
        0,
        Math.round((media.runtimeMinutes ?? 45) * (1 - progressFraction))
      ),
      watched: completed,
      completed
    },
    lastPlayedAt: entry.lastWatchedAt,
    playbackPositionSeconds: Math.round(durationSeconds * progressFraction),
    durationSeconds
  }
}

/**
 * home:personalized's flat `recommendations: CatalogItem[]` has no
 * per-item confidence score or "why" reasons (unlike this dashboard's
 * `Recommendation` type, and unlike the mock AI_PICKS pool it replaces) —
 * the backend's recommendation logic is genre-overlap filtering against
 * `preferredGenres`, not a scored model. `confidence` is synthesized from
 * how many of the item's genres overlap with `preferredGenres` (more
 * overlap -> higher score), and `reasons` names the matched genre(s) —
 * both are honest about what actually drove the match rather than
 * inventing personalization the backend doesn't do.
 */
export function catalogItemToRecommendation(
  item: CatalogItem,
  preferredGenres: string[],
  context: CatalogItemAdapterContext = {}
): Recommendation {
  const matchedGenres = item.genres.filter((g) => preferredGenres.includes(g))
  const confidence =
    preferredGenres.length === 0
      ? 70
      : Math.min(97, 60 + matchedGenres.length * 15 + (parseRating(item.rating) ?? 0) * 2)
  const reasons = matchedGenres.length
    ? matchedGenres.map((g) => `Matches your taste for ${g}`)
    : ['Popular right now']

  const media = catalogItemToMediaItem(item, context)
  return {
    media: { ...media, matchPercentage: Math.round(confidence) },
    confidence: Math.round(confidence),
    reasons,
    generatedAt: new Date().toISOString()
  }
}
