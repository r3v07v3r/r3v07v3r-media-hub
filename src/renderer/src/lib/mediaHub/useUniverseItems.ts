// A universe's titles as cards, by id.
//
// The entries come from the bundled list (shared/media-hub/universes.ts); what
// this adds is everything the local library knows about each one — artwork,
// rating, and above all whether it has been watched — by reading the index
// through the same by-id path My Stuff uses. A title the index has never met
// still gets a card, built from the entry itself: an ordered list with a hole
// where the 1985 cartoon should be is not an ordered list.

import { useMemo } from 'react'

import { useAppState } from '@renderer/context/AppStateContext'
import { useCatalogByIds } from '@renderer/lib/mediaHub/useCatalogByIds'
import type { MediaItem } from '@renderer/types'
import { universeEntryToCatalogItem, type UniverseDefinition } from '@shared/media-hub/universes'

export function useUniverseItems(
  universes: readonly UniverseDefinition[]
): ReadonlyMap<string, MediaItem> {
  const { adaptCatalogItems, catalogKindStates } = useAppState()

  const entries = useMemo(() => universes.flatMap((universe) => universe.entries), [universes])
  const ids = useMemo(() => entries.map((entry) => entry.id), [entries])

  // Refetched when a kind's catalogue settles — on a fresh database this
  // can ask before anything has been indexed (see useCatalogByIds).
  const indexRevision = `${catalogKindStates.movie}:${catalogKindStates.series}:${catalogKindStates.anime}`
  const { items } = useCatalogByIds(ids, adaptCatalogItems, indexRevision)

  return useMemo(() => {
    const byId = new Map<string, MediaItem>()
    for (const item of items) byId.set(String(item.id), item)
    const missing = entries.filter((entry) => !byId.has(entry.id))
    // Through the same adapter as the indexed rows, so a stand-in card
    // still carries its watched, planned and not-interested state.
    for (const item of adaptCatalogItems(missing.map(universeEntryToCatalogItem))) {
      byId.set(String(item.id), item)
    }
    return byId
  }, [items, entries, adaptCatalogItems])
}
