// Repairs anime watch history left behind by the sync bug that idBridge.ts
// and resolveAnimeGroupTarget fix going forward.
//
// WHAT WENT WRONG. Until those landed, MAL's reconcile-apply wrote every
// episode it pulled down under whichever Kitsu id MAL itself had matched,
// at a hardcoded season 1. For a franchise this app merges into one show
// (Naruto + Naruto: Shippuuden, Bleach + Bleach: Sennen Kessen-hen) that id
// is a SIBLING's — not the canonical show id every read in this app keys
// on. The rows are real and correctly dated; they are simply filed under a
// name nothing looks up, which is why a fully watched show still showed as
// unwatched with no episode progress.
//
// WHY REPAIR RATHER THAN CLEAR AND RE-SYNC. Deleting the rows and pulling
// them down again would work only for someone whose remote account still
// has that history, and it would restamp every viewing with the date of
// the re-sync — the cadence profile, the statistics and "recently watched"
// all read those dates. The ids are wrong; the viewings are not. Moving
// them is strictly less destructive than re-fetching them, needs no
// network, and cannot fail halfway leaving somebody with less history than
// they started with.
//
// WHY NOT A SCHEMA MIGRATION. migrations.ts runs at database open, before
// any catalog exists, and each entry runs exactly once. Working out where
// a row BELONGS needs the grouped anime catalog (see animeGroupingReady),
// which on the launch after an update is usually minutes away and on a
// fresh install is not there at all. A migration would find nothing to do,
// mark itself applied, and never look again. This runs as a background job
// instead, so it can wait for grouping and simply try again next launch if
// it is not ready yet.

import type { ContentIdRemap } from './database'
import { animeGroupingReady, resolveAnimeGroupTarget } from './animeSeasons'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { notifyLibraryChanged } from './rendererBridge'
import { readSettings, writeSettings } from './settingsStore'

/**
 * Bumped only if a future change makes the repair worth running again.
 * Stored rather than inferred: once the rows are moved there is nothing
 * left to detect, and re-deriving "has this been done" from the data would
 * mean walking the whole history on every launch forever.
 */
const REPAIR_VERSION = 1

export function animeRepairDone(): boolean {
  return Number(readSettings().animeIdRepairVersion || 0) >= REPAIR_VERSION
}

/**
 * Moves anime rows filed under a merged franchise's sibling id onto the
 * canonical show, at the season that sibling really occupies.
 *
 * Runs at most once per install (see REPAIR_VERSION), and only once the
 * grouping pass has actually produced the answer it needs — until then it
 * reports that it did nothing and leaves the marker alone, so the next
 * launch retries. Never throws: this is unattended background repair, and
 * a failure here must not take a launch down with it.
 */
export function repairAnimeSyncIds(): { repaired: number; ran: boolean } {
  if (animeRepairDone()) return { repaired: 0, ran: true }
  // Nothing to resolve against yet — see animeGroupingReady. Deliberately
  // leaves the marker unset so this is retried rather than written off.
  if (!animeGroupingReady()) return { repaired: 0, ran: false }

  try {
    const db = getDatabase()
    const mappings = new Map<string, ContentIdRemap>()
    // history() is scoped to the active profile, but the ids it turns up
    // are not profile-specific facts — "this kitsu id is season 3 of that
    // show" is true for everybody. remapContentIds then applies each
    // mapping across every profile, which is what lets one pass repair an
    // install whose other profiles nobody has opened yet.
    for (const entry of db.history()) {
      const id = String(entry.id || '')
      if (!id.startsWith('kitsu:') || mappings.has(id)) continue
      const target = resolveAnimeGroupTarget(id)
      // Same id back means this title is not a merged sibling — either the
      // canonical show itself or an ungrouped title, both already correct.
      if (target.id === id) continue
      // The old writer always used season 1, so the sibling's real season
      // IS the offset. Expressed as an offset rather than an assignment so
      // a row that somehow carries a different season keeps its ordering
      // instead of being flattened onto one.
      mappings.set(id, { fromId: id, toId: target.id, seasonOffset: target.season - 1 })
    }

    const repaired = mappings.size ? db.remapContentIds([...mappings.values()]) : 0
    const settings = readSettings()
    settings.animeIdRepairVersion = REPAIR_VERSION
    writeSettings(settings)
    // History, plays and ratings just moved to different ids. Nothing on
    // screen keyed by the old ones is right any more, so every hook starts
    // over — the same reset a profile switch does.
    if (repaired > 0) notifyLibraryChanged('anime-sync-repair', 'all')
    return { repaired, ran: true }
  } catch (error) {
    logError('anime:sync-repair', error)
    // Marker deliberately not written — a failed pass should be retried on
    // the next launch, not silently declared complete.
    return { repaired: 0, ran: false }
  }
}
