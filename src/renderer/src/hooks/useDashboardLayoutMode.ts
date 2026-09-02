'use client'

import { useEffect, useState } from 'react'

/**
 * Which of the dashboard compositions (Home and the category pages share
 * one — see HomeDashboard.module.css / CategoryPage.module.css) the
 * current window can actually hold.
 *
 * The existing breakpoints were all width-driven, but the thing this
 * composition runs out of first is HEIGHT: the full desktop stack needs
 * roughly 994px of `.main` (hero row 480 + AI Picks row 280 + the mood
 * dock's 190px spacer + gaps/padding), which is a 1080px window with
 * nothing to spare. Every shorter window — a 1600x900 laptop panel, a
 * merely-maximized (not full-screen) window on a 1080p display — was
 * silently overflowing: measured at 1599x853, the AI Picks row's bottom
 * landed at y=868 against an 853px viewport and the mood dock covered
 * the cards from y=655 up.
 *
 *   'full'    — the composition as designed. Telemetry gauges, the
 *               520px+ hero.
 *   'short'   — same composition, trimmed to fit: tighter rows, smaller
 *               cards, a shorter dock. Nothing is removed.
 *   'compact' — too short to keep three columns. The assistant panel
 *               collapses to a full-width strip (see
 *               CompactAIAssistant.module.css) and the telemetry gauges
 *               stop rendering — which also stops the main-process WMI
 *               worker feeding them, since it is reference-counted on
 *               renderer subscribers (see src/main/ipc/telemetry.ts).
 *   'stacked' — the pre-existing narrow-width layout (single column,
 *               icon rail / bottom nav). Unchanged by any of the above.
 *
 * Width wins over height: below 1100px the stacked layout already has
 * its own answer for all of this, so the two height tiers deliberately
 * carry `(min-width: 1100px)` and never fight it.
 */
export type DashboardLayoutMode = 'full' | 'short' | 'compact' | 'stacked'

/** Kept beside the CSS that mirrors them so the pair stays honest — every
 *  `@media` block keyed to these numbers references this file by name. */
export const STACKED_QUERY = '(max-width: 1099px)'
export const SHORT_QUERY = '(min-width: 1100px) and (max-height: 1079px)'
export const COMPACT_QUERY = '(min-width: 1100px) and (max-height: 940px)'

function read(): DashboardLayoutMode {
  if (typeof window === 'undefined') return 'full'
  if (window.matchMedia(STACKED_QUERY).matches) return 'stacked'
  if (window.matchMedia(COMPACT_QUERY).matches) return 'compact'
  if (window.matchMedia(SHORT_QUERY).matches) return 'short'
  return 'full'
}

export function useDashboardLayoutMode(): DashboardLayoutMode {
  const [mode, setMode] = useState<DashboardLayoutMode>(read)

  useEffect(() => {
    // One listener per query rather than a window 'resize' handler: a
    // resize fires on every frame of a drag and would re-render the whole
    // dashboard each time, where these fire once, on an actual threshold
    // crossing. The handler still re-reads all three rather than acting
    // on the event it got — the modes are ordered (width beats height),
    // so which query changed says nothing on its own about which mode is
    // now correct.
    const queries = [STACKED_QUERY, SHORT_QUERY, COMPACT_QUERY].map((q) => window.matchMedia(q))
    function onChange() {
      setMode(read())
    }
    // Not redundant with the useState initializer: between that first
    // render and this effect the window can already have been resized,
    // and on the very first mount in a fresh window it is what reconciles
    // the initial guess with reality.
    onChange()
    queries.forEach((q) => q.addEventListener('change', onChange))
    return () => queries.forEach((q) => q.removeEventListener('change', onChange))
  }, [])

  return mode
}
