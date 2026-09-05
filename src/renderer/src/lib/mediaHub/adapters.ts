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
  HistoryEntry,
  MediaKind,
  RecommendationReason,
  TrackedItem,
  TrackedItemEnriched
} from '@shared/media-hub/types'
import { episodeWatchState, hasAired, isRegularEpisode } from '@shared/media-hub/catalog-logic'
import { parseRating, parseRuntimeMinutes, parseYear } from '@shared/media-hub/catalogFields'
import { recommendationReasonLabel } from '@shared/media-hub/recommendationReason'
import type { OllamaTitleRef } from '@shared/media-hub/ollama'
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
// from a MediaItem the user is acting on when the original media kind is
// unavailable. `mediaKind` is preferred below: anime renders as
// `mediaType: 'series'`, but must remain `type: 'anime'` for anime-specific
// tracking such as MyAnimeList sync.
function toMediaKind(type: MediaType): MediaKind {
  if (type === 'episode') return 'series'
  if (type === 'live') return 'movie'
  return type
}

/**
 * The four fields a local model is given about a title — enough to
 * recognise it and say something useful about it, and nothing else. What
 * goes to the model is deliberately explicit here rather than being a
 * MediaItem with most of it ignored: this is the boundary where the app's
 * data leaves for a language model, even one running on the same machine.
 */
export function mediaItemToTitleRef(media: MediaItem): OllamaTitleRef {
  return {
    id: media.id,
    title: media.title,
    year: media.releaseYear,
    genres: media.genres
  }
}

/**
 * The same four fields, straight off a raw backend row.
 *
 * The assistant searches the catalog and hands what it found to the model
 * in the same turn (see AppStateContext runAssistantQuery), which is before
 * those rows have been through catalogItemToMediaItem — that conversion
 * happens in a memo, one render later. Going through MediaItem here would
 * mean either waiting a render or building throwaway MediaItems for their
 * title alone.
 */
export function catalogItemToTitleRef(item: CatalogItem): OllamaTitleRef {
  return {
    id: item.id,
    title: item.title,
    year: parseYear(item.year),
    genres: item.genres
  }
}

/**
 * Minimal outbound payload for tracking:toggle / the `item` half of
 * tracking:mark-watched — only the fields the main process's
 * `TrackableItem`/`SimklPushItem` types actually read (id/type/title/
 * poster/year), plus the known episode total used solely to set the correct
 * MyAnimeList completion status. This is still not a full CatalogItem
 * round-trip.
 */
export function mediaItemToTrackablePayload(media: MediaItem): {
  id: string
  type: MediaKind
  title: string
  poster: string
  year: string
  totalEpisodes?: number
} {
  return {
    id: media.id,
    type: media.mediaKind ?? toMediaKind(media.mediaType),
    title: media.title,
    poster: media.posterUrl ?? '',
    year: media.releaseYear ? String(media.releaseYear) : '',
    ...(media.totalEpisodes != null ? { totalEpisodes: media.totalEpisodes } : {})
  }
}

// parseRuntimeMinutes/parseYear/parseRating used to be defined right here.
// They moved to @shared/media-hub/catalogFields because main now derives the
// same three values when it writes catalog_index, and SQL filters/sorts on
// the result — two copies would be free to drift into meaning different
// things on the two sides of the same filter. See that module's own comment.

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

// `genres` is declared non-optional on CatalogItem, but this runs on the far
// side of an IPC boundary — the type is a promise about the payload, not a
// guarantee of it, and a normalizer that omitted the array once already made
// this throw and blank the entire window (see collection.ts). Tolerating the
// absence here costs one guard; not tolerating it costs the app.
/** The inverse direction of GENRE_MOOD_KEYWORDS, for callers that must ask
 *  the INDEX for mood-relevant rows: does this concrete genre value map to
 *  any of the selected moods? Kept beside the forward mapping so the two
 *  directions cannot drift apart. */
export function genreMatchesMoods(genre: string, moodIds: readonly string[]): boolean {
  const key = genre.trim().toLowerCase()
  for (const [needle, tags] of Object.entries(GENRE_MOOD_KEYWORDS)) {
    if (key.includes(needle) && tags.some((tag) => moodIds.includes(tag))) return true
  }
  return false
}

function genresToMoods(genres: string[] | undefined): string[] {
  const moods = new Set<string>()
  for (const genre of genres ?? []) {
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
  /** ids with at least one watched entry (from tracking:list's `history`) — drives MediaItem.watched (movies: fully accurate; series/anime: "started", not "finished" — see `completed` below). */
  watchedIds?: Set<string>
  /** The full per-episode watch history (same source as watchedIds, unflattened) — needed to compute a series/anime's real completion state via episodeWatchState, which watchedIds alone (just an id set) can't do. Undefined is treated as "no history known yet", not "nothing watched" — see completed's fallback below. */
  history?: HistoryEntry[]
  /** `history` pre-grouped by content id (see indexHistoryById). Strictly an
   *  optimisation, and only worth it when converting many items at once —
   *  which is the normal case, since the whole catalog goes through this.
   *
   *  Without it, every item re-filters the ENTIRE history to find its own
   *  entries, so mapping the catalog costs O(items x history): with a
   *  thousand-plus anime entries and a real viewing history that is a
   *  measurable pause on something as small as adding one title to My List
   *  (which replaces the tracked-id set and so re-derives everything).
   *  Supplying the index makes it O(items + history). */
  historyById?: ReadonlyMap<string, HistoryEntry[]>
  /** ids explicitly marked "Not interested" (from disliked:list) — drives MediaItem.disliked. */
  dislikedIds?: Set<string>
  /** Why the ranker put THIS title in the suggestion row — home:personalized's
   *  `recommendationReasons`, looked up per item. Only meaningful for
   *  catalogItemToRecommendation; every other conversion ignores it. */
  reason?: RecommendationReason
}

/** Groups a flat watch history by content id, once, for callers about to
 *  convert a batch of items (see CatalogItemAdapterContext.historyById).
 *  Ids are stringified to match episodeWatchState's own comparison. */
export function indexHistoryById(history: HistoryEntry[]): Map<string, HistoryEntry[]> {
  const index = new Map<string, HistoryEntry[]>()
  for (const entry of history) {
    const key = String(entry?.id ?? '')
    const bucket = index.get(key)
    if (bucket) bucket.push(entry)
    else index.set(key, [entry])
  }
  return index
}

/**
 * The episodes that count toward a title's progress — the denominator for
 * "how far through this am I".
 *
 * Three exclusions, for three different reasons:
 *
 * v.unplayable (see disambiguateVideos in core.ts) is a synthetic Specials
 * entry with no real episode behind it — its watched controls are hidden,
 * so it can never appear in `history`. Counting it would mean watchedCount
 * could never reach total, permanently blocking a series from reading as
 * complete even after every real episode is watched.
 *
 * A genuine season-0 special (isRegularEpisode, shared/catalog-logic.ts)
 * is real and watchable but is not progress: a show is complete when its
 * numbered episodes are watched, whether or not the OVAs were.
 *
 * Unaired/future episodes (Cinemeta and TMDB both include these in
 * `videos`) are excluded so a currently-airing show someone is fully
 * caught up on isn't permanently short of 100%.
 *
 * Shared by isSeriesCompleted below and MediaDetailPage's own Tracked &
 * Progress counts, so the "Completed" badge on a catalog card and the
 * percentage in the detail sidebar can't disagree about the denominator.
 */
export function airedEpisodes<
  T extends { unplayable?: boolean; released?: string; season?: number | null }
>(videos: readonly T[] | undefined, now: number = Date.now()): T[] {
  // hasAired and isRegularEpisode, not inline checks: the same two rules
  // decide which episode a Play button starts (see nextEpisode.ts), and
  // two copies of either would eventually disagree.
  return (videos || []).filter((v) => isRegularEpisode(v) && hasAired(v, now))
}

/** A series/anime counts as complete once every already-aired episode has
 *  been watched — a still-airing show the person is fully caught up on
 *  counts too (nothing new to watch right now), but a show they're
 *  partway through does not. */
function isSeriesCompleted(item: CatalogItem, history: HistoryEntry[]): boolean {
  const aired = airedEpisodes(item.videos)
  if (!aired.length) return false
  const state = episodeWatchState(aired, history, item.id)
  return state.total > 0 && state.watchedCount >= state.total
}

/** Season/episode counts for series+anime, derived from CatalogItem.videos
 *  — that list is the backend's own per-episode data (see Episode's
 *  season/episode/number fields), not a separate aggregate the backend
 *  computes, so this is the only place that count exists. Returns
 *  undefined counts (not 0) when there's no episode list at all, so the
 *  UI can tell "no episode data available" apart from "confirmed zero
 *  episodes." */
function seasonEpisodeCounts(
  videos: CatalogItem['videos'] | undefined,
  episodeCounts: CatalogItem['episodeCounts']
): {
  totalSeasons?: number
  totalEpisodes?: number
} {
  // A grouped anime's `videos` only ever covers its own (first) season —
  // see CatalogItem.episodeCounts' own doc comment for why — so when a
  // normalizer has supplied the real combined totals directly, trust
  // that instead of under-counting from `videos`. Ungrouped anime and
  // every other normalizer (Cinemeta, Simkl, TMDB) never set this, so
  // they fall through to the exact derivation this function always did.
  if (episodeCounts) return episodeCounts

  // v.unplayable entries (disambiguateVideos, core.ts) are synthetic —
  // promotional clips reassigned into a fabricated season 0, not real
  // episodes — so they're excluded here too, or they'd inflate both the
  // episode count and (by introducing a season that wouldn't otherwise
  // exist) the season count.
  const playable = (videos || []).filter((v) => isRegularEpisode(v))
  if (playable.length === 0) return {}
  const seasons = new Set(playable.map((v) => v.season).filter((s) => Number.isFinite(s)))
  return {
    totalSeasons: seasons.size || undefined,
    totalEpisodes: playable.length
  }
}

/** The single conversion every other adapter in this file builds on. */
export function catalogItemToMediaItem(
  item: CatalogItem,
  context: CatalogItemAdapterContext = {}
): MediaItem {
  const watched = context.watchedIds?.has(item.id) ?? false
  // Prefer the pre-grouped index when the caller supplied one — same
  // answer, without re-scanning the whole history for every single item.
  const ownHistory = context.historyById
    ? (context.historyById.get(item.id) ?? [])
    : (context.history ?? [])
  const completed = item.type === 'movie' ? watched : isSeriesCompleted(item, ownHistory)
  const disliked = context.dislikedIds?.has(item.id) ?? false
  const { totalSeasons, totalEpisodes } = seasonEpisodeCounts(item.videos, item.episodeCounts)
  return {
    id: item.id,
    mediaType: toMediaType(item.type),
    mediaKind: item.type,
    title: item.title,
    // The romaji under an anime's English name — DetailHero draws
    // `subtitle` beside the title, and stream resolution reads
    // originalTitle as the name releases actually carry.
    ...(item.originalTitle
      ? { subtitle: item.originalTitle, originalTitle: item.originalTitle }
      : {}),
    description: item.description || undefined,
    posterUrl: item.poster || undefined,
    backdropUrl: item.background || undefined,
    logoUrl: item.logo || undefined,
    releaseYear: parseYear(item.year),
    runtimeMinutes: parseRuntimeMinutes(item.runtime),
    genres: item.genres ?? [],
    moods: genresToMoods(item.genres),
    // Present only on a resolved detail-page item — the catalog list
    // carries none of these (see credits.ts on why they are not on the
    // catalog blob), so these are undefined for every grid card.
    cast: item.cast?.length ? item.cast : undefined,
    creators: item.creators?.length ? item.creators : undefined,
    storyTags: item.keywords?.length ? item.keywords : undefined,
    communityRating: parseRating(item.rating),
    imdbRating: parseRating(item.rating),
    rottenTomatoesRating: parseRating(item.rottenTomatoesRating || ''),
    totalSeasons,
    totalEpisodes,
    status: item.status || undefined,
    watched,
    completed,
    disliked,
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
  // The reason the RANKER gave, not one re-derived here.
  //
  // What this replaces was a second opinion about an ordering it did not
  // produce: it re-matched genres case-sensitively where the ranking
  // lowercases, so the two could disagree about the same title, and where
  // it found nothing it asserted "Popular right now" — a claim about a
  // figure this app has never measured, over a title that was in fact
  // there because of a franchise continuation, a director, or nothing in
  // particular. Nothing consumed it, which is the only reason that never
  // reached anybody.
  //
  // Empty when the ranker had nothing to point at. Callers render that as
  // no chip, not as an empty one — see recommendationReasonLabel.
  const label = recommendationReasonLabel(context.reason)
  const reasons = label ? [label] : []

  const media = catalogItemToMediaItem(item, context)
  return {
    media: { ...media, matchPercentage: Math.round(confidence) },
    confidence: Math.round(confidence),
    reasons,
    generatedAt: new Date().toISOString()
  }
}
