// The big collections: a whole universe in order, films and series together.
//
// A film's own page already lists its series (CollectionPanel, from TMDB's
// collection), and that stops exactly where the question gets interesting.
// "Iron Man Collection" is three films; the thing somebody wants to work
// through is the sixty-odd films and series around them, and no catalogue this
// app reads models that — nor the order the story runs in, which differs from
// the order it was released in for every universe worth listing.
//
// So which titles belong, and the story order, are kept by hand in
// scripts/build-universes.mjs (see its header for what was tried instead), and
// that script writes universeData.ts with the titles and dates checked against
// Cinemeta. This module is the pure part both sides share: the shapes, the two
// orders, and a card for a title the local index has not met yet.

import type { CatalogItem } from './types'
import { UNIVERSE_DATA } from './universeData'

export interface UniverseEntry {
  /** IMDb id — what the movie and series catalogues are keyed by. */
  id: string
  type: 'movie' | 'series'
  title: string
  year: string
  /** YYYY-MM-DD: a film's release, a series' first episode. Empty when
   *  neither source had a day, and then `year` is all the ordering has. */
  released: string
}

export interface UniverseDefinition {
  id: string
  name: string
  blurb: string
  /** Whether `entries` is written in the order the story happens. Without
   *  it the list is in no particular order and only release order is real. */
  hasStoryOrder: boolean
  entries: UniverseEntry[]
}

export type UniverseOrder = 'story' | 'release'

export const UNIVERSES: readonly UniverseDefinition[] = UNIVERSE_DATA

export function findUniverse(id: string): UniverseDefinition | undefined {
  return UNIVERSES.find((universe) => universe.id === id)
}

/** A date to sort by. An entry with only a year goes to the end of that
 *  year rather than its start: unknown is not "first". */
const releaseKey = (entry: UniverseEntry): string =>
  entry.released || `${entry.year || '9999'}-12-31`

/**
 * A universe's titles in the order asked for.
 *
 * Story order is the list as written. It places a series where it STARTS —
 * a show that runs alongside five films is one card, not five — so it is a
 * viewing order rather than a strict timeline. Asking for it of a universe
 * that has none gives release order, never the arbitrary written one.
 */
export function universeEntries(
  universe: UniverseDefinition,
  order: UniverseOrder
): UniverseEntry[] {
  if (order === 'story' && universe.hasStoryOrder) return [...universe.entries]
  // Array.prototype.sort is stable, so two titles released the same day
  // (Droids and Ewoks premiered together) keep the order they are written in.
  return [...universe.entries].sort((a, b) => releaseKey(a).localeCompare(releaseKey(b)))
}

/** Whether a title is out yet, to the day. An entry with no date is judged
 *  by its year, and counts as out during it. */
export function universeEntryReleased(entry: UniverseEntry, today: string): boolean {
  if (entry.released) return entry.released <= today
  return Boolean(entry.year) && entry.year <= today.slice(0, 4)
}

/**
 * A catalogue record for an entry the local index does not hold.
 *
 * The index is what has been crawled so far, and a universe reaches well
 * outside it (the 1985 Ewoks cartoon is in nobody's top two thousand). A
 * gap in the list would break the one thing this page is for, so the entry
 * stands in with what is known here; the artwork is Cinemeta's own, which
 * is addressed by the same IMDb id. Opening the card loads the real record.
 */
export function universeEntryToCatalogItem(entry: UniverseEntry): CatalogItem {
  return {
    id: entry.id,
    type: entry.type,
    title: entry.title,
    poster: `https://images.metahub.space/poster/small/${entry.id}/img`,
    background: `https://images.metahub.space/background/medium/${entry.id}/img`,
    logo: '',
    year: entry.year,
    releaseDate: entry.released,
    description: '',
    rating: '',
    runtime: '',
    genres: [],
    videos: [],
    trailers: []
  }
}
