// A universe's titles as cards, by id.
//
// The entries come from the bundled list (shared/media-hub/universes.ts); what
// this adds is everything the local library knows about each one — artwork,
// rating, and above all whether it has been watched — by reading the index
// through the same by-id path My Stuff uses. A title the index has never met
// still gets a card, built from the entry itself: an ordered list with a hole
// where the 1985 cartoon should be is not an ordered list.

import { useEffect, useMemo, useState } from 'react'

import { useAppState } from '@renderer/context/AppStateContext'
import { useCatalogByIds } from '@renderer/lib/mediaHub/useCatalogByIds'
import type { MediaItem } from '@renderer/types'
import type { HistoryEntry } from '@shared/media-hub/types'
import { universeEntryToCatalogItem, type UniverseDefinition } from '@shared/media-hub/universes'

export function useUniverseItems(
  universes: readonly UniverseDefinition[]
): ReadonlyMap<string, MediaItem> {
  const { adaptCatalogItems, catalogKindStates } = useAppState()

  const entries = useMemo(() => universes.flatMap((universe) => universe.entries), [universes])
  // A series split by season is listed once per season, and fetched once.
  const ids = useMemo(() => [...new Set(entries.map((entry) => entry.id))], [entries])

  // Refetched when a kind's catalogue settles — on a fresh database this
  // can ask before anything has been indexed (see useCatalogByIds).
  const indexRevision = `${catalogKindStates.movie}:${catalogKindStates.series}:${catalogKindStates.anime}`
  const { items } = useCatalogByIds(ids, adaptCatalogItems, indexRevision)

  return useMemo(() => {
    const byId = new Map<string, MediaItem>()
    for (const item of items) byId.set(String(item.id), item)
    const missing = entries.filter(
      (entry, index) =>
        !byId.has(entry.id) && entries.findIndex((other) => other.id === entry.id) === index
    )
    // Through the same adapter as the indexed rows, so a stand-in card
    // still carries its watched, planned and not-interested state.
    for (const item of adaptCatalogItems(missing.map(universeEntryToCatalogItem))) {
      byId.set(String(item.id), item)
    }
    return byId
  }, [items, entries, adaptCatalogItems])
}

/**
 * The watched episodes of every series these universes list a season at a
 * time — what tells a season stop is done, which the show's own flags cannot
 * (a show half watched has some seasons finished). Null until read, and not
 * read at all when no universe here is split. Read again whenever watch
 * status changes anywhere, as the detail page reads its own, and whenever
 * the library itself changes (another profile, a restored backup).
 */
export function useSeasonHistory(
  universes: readonly UniverseDefinition[]
): readonly HistoryEntry[] | null {
  const { watchStatusVersion, libraryKey } = useAppState()
  // Kept with the library it was read from, so a profile switch or a
  // restored backup shows nothing until its own history is in, rather than
  // the last library's.
  const [read, setRead] = useState<{ libraryKey: string; rows: readonly HistoryEntry[] } | null>(
    null
  )
  const splitIds = useMemo(
    () =>
      [
        ...new Set(
          universes.flatMap((universe) =>
            universe.entries.filter((entry) => entry.part).map((entry) => entry.id)
          )
        )
      ].join(' '),
    [universes]
  )

  useEffect(() => {
    const api = window.api?.mediaHub?.tracking
    if (!splitIds || !api) return
    const wanted = new Set(splitIds.split(' '))
    let cancelled = false
    api
      .list()
      .then((result) => {
        if (!cancelled) {
          setRead({ libraryKey, rows: result.history.filter((row) => wanted.has(row.id)) })
        }
      })
      .catch(() => {
        // Left as it was: a season stop then goes by the show's own flags.
      })
    return () => {
      cancelled = true
    }
  }, [splitIds, watchStatusVersion, libraryKey])

  return read?.libraryKey === libraryKey ? read.rows : null
}
