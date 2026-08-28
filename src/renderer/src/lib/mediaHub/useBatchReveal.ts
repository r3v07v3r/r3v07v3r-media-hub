import { Dispatch, SetStateAction, useState } from 'react'
import type { MediaItem } from '@renderer/types'
import { listChange } from './listChange'

/**
 * Manages a lazily-revealed batch count for a large item list (see
 * MediaGrid.tsx / AnimeLibraryPage.tsx's EverythingSection), resetting to
 * `batchSize` only when the VIEW itself changes — a different `viewKey`
 * — rather than every time the underlying `items` array reference does.
 *
 * A plain array diff can't reliably tell "the user changed filters and
 * got a similarly-sized, mostly-overlapping result" apart from "one
 * item's watched state changed while browsing the same view": a broad
 * genre/rating filter narrowing 100 titles to 85 keeps a 0.85 overlap
 * ratio, and since filtering doesn't reorder the survivors, listChange's
 * relative-order check doesn't catch it either — both signals say
 * "edited," wrongly preserving a deep reveal count against a much
 * shorter list.
 *
 * `viewKey` is the authoritative signal for "this is a different view"
 * instead — callers derive it from whatever actually defines the view
 * (filters + sort + search state + category kind; see
 * AnimeLibraryPage.tsx's own `viewKey` for the concrete recipe). Once the
 * view key is stable, anything else that changes `items` is by
 * definition a catalog-side edit within that same view, and gets the
 * softer same/edited/different classification from listChange instead —
 * kept as a defensive fallback for a caller whose `items` genuinely
 * diverges wholesale without the view key changing, rather than the
 * primary signal it used to be.
 */
export function useBatchReveal(
  items: MediaItem[],
  viewKey: string,
  batchSize: number,
  initialCount?: number
): [number, Dispatch<SetStateAction<number>>] {
  const [visibleCount, setVisibleCount] = useState(initialCount ?? batchSize)
  const [itemsForReset, setItemsForReset] = useState(items)
  const [viewKeyForReset, setViewKeyForReset] = useState(viewKey)

  if (viewKeyForReset !== viewKey) {
    setViewKeyForReset(viewKey)
    setItemsForReset(items)
    setVisibleCount(batchSize)
  } else if (itemsForReset !== items) {
    setItemsForReset(items)
    const change = listChange(itemsForReset, items)
    if (change === 'different') {
      setVisibleCount(batchSize)
    } else if (change === 'edited') {
      setVisibleCount((count) => Math.min(Math.max(count, batchSize), items.length))
    }
  }

  return [visibleCount, setVisibleCount]
}
