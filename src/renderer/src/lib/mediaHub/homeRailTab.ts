// Which of Home's two rails — Recommended or Planned — is the open tab.
//
// Module-level rather than component state, for the same reason
// hooks.ts's startup fallbacks are: Home UNMOUNTS when a title is opened
// from it, so anything held in a useState is gone by the time the person
// presses Back. That mattered here beyond mere convenience. The browsing
// origin captured on the way out records the `planned` rail's offset and
// the card that was focused in it; if Home comes back with Recommended
// selected, neither the rail nor the card is in the DOM when
// restoreBrowsingOrigin runs — and it consumes the pending origin either
// way, so the position was not merely deferred, it was lost.
//
// Deliberately not persisted to storage: this is "where you were a moment
// ago", not a preference. A cold start opens on Recommended.

export type HomeRailTab = 'picks' | 'planned'

let active: HomeRailTab = 'picks'

/** Read at mount (and by HomeDashboard, to decide what "ready to restore"
 *  means for the tab that is about to render). Changes only through a
 *  click, which re-renders the carousel that made it — nothing else
 *  subscribes, so there is no torn state to guard against. */
export function activeHomeRailTab(): HomeRailTab {
  return active
}

export function setActiveHomeRailTab(tab: HomeRailTab): void {
  active = tab
}
