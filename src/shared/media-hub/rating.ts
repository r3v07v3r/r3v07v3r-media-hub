// A personal score, and what it is worth to the ranking.
//
// WHY 1-10 AND NOT STARS. Every service this app already syncs with speaks
// this scale — Simkl, MyAnimeList and AniList are all 1-10, and Trakt is too.
// Storing five stars and doubling on the way out would lose the half that
// people actually use, and inventing a scale of our own would mean a lossy
// conversion in both directions for no gain.
//
// WHY THERE IS NO ZERO. Zero would have to mean either "no opinion" or "the
// worst thing I have ever seen", and it cannot mean both. Absence means no
// opinion; 1 is the lowest opinion. The UI's clear action sends 0 precisely
// so the storage layer reads it as "remove this", which is why `rate` treats
// anything outside the range as a removal rather than an error.

export const MIN_RATING = 1
export const MAX_RATING = 10

/**
 * What one watched title is worth when learning what somebody likes.
 *
 * The recommender has always treated everything in the history identically:
 * a film somebody finished and resented counted exactly as much toward their
 * taste as one they loved. This is the correction — the same signals, weighed
 * by how they actually landed.
 *
 * The shape is deliberate at both ends.
 *
 * UNRATED IS 1, not 0. Most of anyone's history will never be rated, and a
 * profile that only learned from rated titles would learn almost nothing.
 * Neutral means an unrated library ranks exactly as it did before ratings
 * existed, which is the property that makes this safe to turn on for
 * everybody at once.
 *
 * A BAD RATING IS 0, not negative. It is tempting to make a 2 push its genres
 * and its cast DOWN, but that reads the score for more than it says: somebody
 * who disliked one action film has not told you they dislike action, and the
 * app already has an explicit control for "less like this" — the dislike. A
 * low score withdraws its vote; it does not cast the opposite one.
 */
export function ratingWeight(score: number | undefined | null): number {
  if (score == null || !Number.isFinite(score)) return 1
  if (score <= 4) return 0
  if (score <= 6) return 0.5
  if (score <= 8) return 1.5
  return 2
}

/** A short label for a score, for a control that shows what it means. */
export function ratingLabel(score: number): string {
  if (score <= 2) return 'Terrible'
  if (score <= 4) return 'Bad'
  if (score <= 6) return 'Okay'
  if (score <= 8) return 'Good'
  if (score <= 9) return 'Great'
  return 'Perfect'
}
