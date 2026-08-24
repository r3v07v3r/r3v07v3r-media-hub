import type { MediaItem, Recommendation } from '@renderer/types'
import { applyWatchStateFilters } from './categoryFilters'

export const SPOTLIGHT_PICK_COUNT = 4

export type MoodWatchStateFilters = Parameters<typeof applyWatchStateFilters>[1]

/**
 * Mood selection deliberately keeps the current "match any selected mood"
 * meaning. A multi-mood choice broadens the set instead of pretending it is
 * a stricter genre intersection.
 */
export function matchesSelectedMoods(item: MediaItem, moodIds: readonly string[]): boolean {
  return moodIds.length > 0 && Boolean(item.moods?.some((mood) => moodIds.includes(mood)))
}

/**
 * Orders the small Spotlight tray around real recommendations first, then
 * around the next most useful unwatched/highly rated title. It is intentionally
 * local and deterministic: no extra request or unsupported claim of AI
 * personalization is needed for a mood click to feel considered.
 */
export function rankMoodSpotlight(
  catalog: MediaItem[],
  recommendations: Recommendation[],
  moodIds: readonly string[],
  filters: MoodWatchStateFilters
): MediaItem[] {
  const recommendationStrength = new Map<string, number>()
  for (const recommendation of recommendations) {
    const id = recommendation.media.id
    recommendationStrength.set(
      id,
      Math.max(recommendationStrength.get(id) ?? 0, recommendation.confidence)
    )
  }

  return applyWatchStateFilters(
    catalog.filter((item) => matchesSelectedMoods(item, moodIds)),
    filters
  ).sort((a, b) => {
    const recommendationDelta =
      (recommendationStrength.get(b.id) ?? 0) - (recommendationStrength.get(a.id) ?? 0)
    if (recommendationDelta !== 0) return recommendationDelta

    if (a.watched !== b.watched) return a.watched ? 1 : -1

    const ratingDelta =
      (b.communityRating ?? b.imdbRating ?? 0) - (a.communityRating ?? a.imdbRating ?? 0)
    if (ratingDelta !== 0) return ratingDelta

    const releaseDelta = (b.releaseYear ?? 0) - (a.releaseYear ?? 0)
    if (releaseDelta !== 0) return releaseDelta

    return a.title.localeCompare(b.title)
  })
}

export interface MoodSpotlightShuffle {
  picks: MediaItem[]
  seenIds: string[]
}

/**
 * Draws a fresh four-title surprise set. When fewer unseen titles remain than
 * a complete tray, those remaining titles always appear before the cycle is
 * allowed to restart. That gives "Surprise me" variety without silently
 * starving a small mood pool.
 */
export function shuffleMoodSpotlight(
  ranked: MediaItem[],
  seenIds: readonly string[],
  random: () => number = Math.random,
  count = SPOTLIGHT_PICK_COUNT
): MoodSpotlightShuffle {
  if (ranked.length === 0 || count <= 0) return { picks: [], seenIds: [] }

  const seen = new Set(seenIds)
  const unseen = ranked.filter((item) => !seen.has(item.id))
  const source =
    unseen.length >= count ? unseen : [...unseen, ...ranked.filter((item) => seen.has(item.id))]
  const shuffled = [...source]

  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1))
    ;[shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]]
  }

  const picks = shuffled.slice(0, Math.min(count, shuffled.length))
  const allSeen = new Set([...seenIds, ...picks.map((item) => item.id)])
  const exhausted = ranked.every((item) => allSeen.has(item.id))

  return {
    picks,
    seenIds: exhausted ? picks.map((item) => item.id) : Array.from(allSeen)
  }
}
