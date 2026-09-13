// Turning a RecommendationReason into the sentence a card shows.
//
// Separate from the ranker that emits the reason, and shared rather than
// renderer-local, for one reason: the words are the part most likely to be
// wanted somewhere else — a tooltip, a detail page, an export — and a
// second copy of them is how "Because you watched X" and "Since you
// watched X" end up on the same screen.
//
// Every label names its evidence. There is deliberately no generic
// fallback string here: a reason with nothing to point at is never emitted
// (see strongestReason in catalog-logic.ts), so there is nothing for a
// fallback to describe, and inventing one — "Popular right now", over a
// figure this app has never measured — is how a chip row stops being worth
// reading.

import type { RecommendationReason } from './types'

/**
 * The chip's text, or an empty string when there is nothing honest to say.
 *
 * Empty is a real answer and callers must render it as no chip at all,
 * not as an empty one.
 */
export function recommendationReasonLabel(reason: RecommendationReason | undefined): string {
  const detail = String(reason?.detail ?? '').trim()
  if (!reason || !detail) return ''
  switch (reason.kind) {
    // The instalment after something watched days ago. Short, because it
    // sits on a card: "Next after" says both that it follows and what.
    case 'next':
      return `Next after ${detail}`
    case 'continues':
      return `Because you watched ${detail}`
    // Directors for a film, creators for a show, studios for anime — one
    // preposition has to cover all three, and "From" is the only one that
    // is not wrong for any of them.
    case 'creator':
      return `From ${detail}`
    case 'cast':
      return `With ${detail}`
    case 'genre':
      return `More ${detail}`
    // The year itself, not "new this year": the ranking also boosts LAST
    // year's releases, and a list read in January is mostly made of them.
    case 'new':
      return `New in ${detail}`
    default:
      return ''
  }
}

/**
 * A shelf's heading. The same words as the chip for every shelf but one:
 * the "next" shelf gathers every continuation at once — one per series
 * somebody is part-way through — so it names the idea rather than a
 * single title (see groupRecommendationRails, which files them under one
 * shelf with an empty detail). Empty means no shelf, as with the chip.
 */
export function recommendationRailTitle(reason: RecommendationReason | undefined): string {
  if (reason?.kind === 'next' && !String(reason.detail ?? '').trim())
    return 'Up next in your series'
  return recommendationReasonLabel(reason)
}
