// Repairs anime watch history filed under a merged franchise's later
// season instead of under the show.
//
// Two things wrote such rows. The first is described below. The second went
// on after it was fixed: a later season opened by its own id (a plan card a
// watchlist pull added) had a page of its own, and whatever was watched
// from that page was written under that id — at whatever season Kitsu
// labels the entry, which is not always 1. Such a page no longer exists
// (see CatalogItem.seasonOf) and a write under such an id is kept under the
// show (tracking.ts's underShow); version 2 of this repair moves the rows
// already written.
//
// A third thing strands rows without writing any: the grouping itself
// changing which id fronts a show, or the order of its seasons. From the
// first pass after the ledger exists that is followed as it happens
// (keepAnimeHistoryWithShows below, animeRegroup.ts). Version 3 of the
// repair places what such a change left behind before then.
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

import type { CatalogItem } from '../../shared/media-hub/types'
import type { ContentIdRemap } from './database'
import {
  animeGroupRecordsOf,
  followAnimeRegroup,
  strandedSeasonMoves,
  type AnimeHistoryMove
} from './animeRegroup'
import {
  animeGroupingReady,
  cachedTvdbSeries,
  currentAnimeGroups,
  groupedIdsFor,
  resolveAnimeGroupTarget,
  seasonMatchesPage
} from './animeSeasons'
import { getDatabase } from './dbState'
import { logError } from './logger'
import { requestRecommendationsRebuild } from './recommendations'
import { notifyLibraryChanged } from './rendererBridge'
import { readSettings, writeSettings } from './settingsStore'

/**
 * Bumped only if a future change makes the repair worth running again.
 * Stored rather than inferred: once the rows are moved there is nothing
 * left to detect, and re-deriving "has this been done" from the data would
 * mean walking the whole history on every launch forever.
 *
 * 2: rows written from a later season's own page, which went on being
 * written after version 1 ran.
 *
 * 3: the seasons of an id that once fronted its show. Version 2 could place
 * only that id's own season and left the rest; where each of the rest
 * belongs can be worked out, they are placed (animeRegroup.ts's
 * placeStrandedSeasons).
 */
const REPAIR_VERSION = 3

function animeRepairDone(): boolean {
  return Number(readSettings().animeIdRepairVersion || 0) >= REPAIR_VERSION
}

/**
 * Moves anime rows to where the grouping now in the catalog puts them, and
 * notes that grouping as the one they are filed under — animeRegroup.ts
 * has the rules. Returns how many rows moved.
 *
 * Called by catalog.ts at the two moments the grouping in the catalog
 * changes hands: when a pass lands, and just before a new crawl overwrites
 * a grouped catalog with a raw one (the last chance to note a grouping no
 * pass since the ledger existed has reported). The repair job calls it as
 * well, for a pass that landed and whose rows never moved because the app
 * closed between the two writes. With nothing changed it is one small read
 * and a comparison.
 *
 * Never throws: it runs inside the grouping pass's own completion, and a
 * failure here must not cost the catalog the grouping it just earned. The
 * ledger is only written with the moves, so a failed run is simply retried
 * by the next caller.
 */
export function keepAnimeHistoryWithShows(): number {
  try {
    // A raw catalog has no groups in it. Compared against that, every show
    // on record would look as if it had come apart. See animeGroupingReady.
    if (!animeGroupingReady()) return 0
    // And no catalog at all has no groups for the same wrong reason.
    const groups = currentAnimeGroups()
    if (!groups) return 0
    const result = followAnimeRegroup(
      getDatabase(),
      animeGroupRecordsOf(groups, cachedTvdbSeries),
      seasonMatchesPage
    )
    for (const miss of result.left) {
      logError('anime:regroup', `${miss.id} left where it is: ${miss.why}`)
    }
    if (result.moved > 0) {
      // Same reset as the repair below: nothing on screen keyed by the old
      // ids or seasons is right any more, and the ranking read those rows.
      notifyLibraryChanged('anime-regroup', 'all')
      requestRecommendationsRebuild()
    }
    return result.moved
  } catch (error) {
    logError('anime:regroup', error)
    return 0
  }
}

/**
 * What placeStrandedSeasons needs to know about the show `id` is a later
 * season of now. The episode counts are read only if asked for: they cost a
 * parse of the whole catalog, and almost no id has anything stranded.
 */
function strandedShow(id: string, showId: string): Parameters<typeof strandedSeasonMoves>[2] {
  const db = getDatabase()
  const members = [showId, ...(groupedIdsFor(showId) || [])]
  let counts: Map<string, number> | null = null
  const episodesOf = (member: string): number | null => {
    if (!counts) {
      counts = new Map()
      // Every member but the first has an index row that is its own: only
      // the id fronting a show is ever refreshed with the whole show's
      // totals. The first member's own count is its catalog entry's
      // episode list, which grouping leaves as it was.
      for (const item of db.indexByIds(members).items) {
        if (item.type === 'anime' && item.id !== showId) {
          counts.set(item.id, item.episodeCounts?.totalEpisodes ?? 0)
        }
      }
      const front = (
        db.getCache<CatalogItem[]>('catalog:v2:anime', { allowExpired: true }) || []
      ).find((item) => String(item.id) === showId)
      if (front) counts.set(showId, front.videos?.length ?? 0)
    }
    return counts.get(member) || null
  }
  return {
    group: { id: showId, members, series: cachedTvdbSeries(showId) },
    episodesOf,
    // The siblings the index remembers this id having, from when it
    // fronted the show: grouped_ids is written for a fronting id and never
    // cleared.
    remembered: db.indexByIds([id]).items.find((item) => item.type === 'anime')?.groupedIds
  }
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
    const stranded: AnimeHistoryMove[] = []
    // Every profile's ids, not the active one's: "this kitsu id is season 3
    // of that show" is true for everybody, remapContentIds applies each
    // mapping across every profile, and an id only another profile holds
    // rows under needs the repair as much.
    for (const id of db.animeHistoryIds()) {
      if (mappings.has(id)) continue
      const target = resolveAnimeGroupTarget(id)
      // Same id back means this title is not a merged sibling — either the
      // canonical show itself or an ungrouped title, both already correct.
      if (target.id === id) continue
      // Its place in the group has to be its season on the show's page, or
      // the rows would land on a different season and mark it watched (see
      // seasonMatchesPage). Where that cannot be shown they stay where they
      // are, under an id that still opens as itself.
      if (!seasonMatchesPage(target.id, id, target.season)) continue
      // Every row of a later season is that one season of the show,
      // whatever season the row carries: the old sync wrote a 1, but a row
      // written from the season's own page carries Kitsu's label for the
      // entry, which for a second season is often already 2. The episode
      // number is the entry's own either way. remapContentIds holds back
      // the one kind of row this cannot be said of — an id that once
      // fronted the whole show — rather than guess where it goes.
      mappings.set(id, { fromId: id, toId: target.id, season: target.season })
      // That one kind of row: worked out here, while the rows are still as
      // they were written, and moved after the remap has taken the id's own
      // season. What cannot be placed is named in the log and stays.
      const seasons = strandedSeasonMoves(db, id, strandedShow(id, target.id))
      stranded.push(...seasons.moves)
      for (const miss of seasons.left) {
        logError('anime:sync-repair', `${miss.id} left where it is: ${miss.why}`)
      }
    }

    let repaired = mappings.size ? db.remapContentIds([...mappings.values()]) : 0
    if (stranded.length) repaired += db.moveAnimeHistory({ moves: stranded }).history
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
