// "Show me others" on a suggestion row.
//
// The ranking is deterministic, so the same titles led a row for as long as
// the watch history stood still — days, for somebody who wanted none of
// them. The cards actually on screen are sent to the back of the ranking
// for a few weeks (main/media-hub/recommendations.ts's PASSED_OVER_MS); the
// caller scrolls back to the start and refetches the feed, and the row
// opens on whatever was behind them.

/** Ids of the cards (`[data-media-id]`) whose middle is inside the scroller's visible width. */
export function visibleMediaIds(scroller: HTMLElement): string[] {
  // Client rects, not offsetLeft: a card's offsetParent is whichever
  // ancestor is positioned, which is not the scroller on every shelf.
  const { left, right } = scroller.getBoundingClientRect()
  return Array.from(scroller.querySelectorAll<HTMLElement>('[data-media-id]'))
    .filter((card) => {
      const rect = card.getBoundingClientRect()
      const middle = rect.left + rect.width / 2
      return middle > left && middle < right
    })
    .map((card) => card.dataset.mediaId ?? '')
    .filter(Boolean)
}

/** Passes over what is on screen in `scroller`. False when nothing was sent or the write failed. */
export async function passOverVisible(scroller: HTMLElement): Promise<boolean> {
  const api = window.api?.mediaHub
  const ids = visibleMediaIds(scroller)
  if (!api || ids.length === 0) return false
  try {
    await api.home.passOver(ids)
    return true
  } catch {
    return false
  }
}
