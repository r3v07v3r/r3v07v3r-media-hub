'use client'

import { useAppState } from '@renderer/context/AppStateContext'

/** True when the person has explicitly turned off decorative UI animation
 *  in Settings > More Options — see global.css's
 *  `[data-motion-user-disabled='true'] *` rule. A standing preference,
 *  layered alongside (not replacing) useMotionSuspended's automatic
 *  hidden/playing check. `mediaHubSettings === null` (bridge missing, or
 *  the first settings fetch hasn't resolved yet) defaults to enabled,
 *  matching every other settings-backed default in this app. */
export function useMotionUserDisabled(): boolean {
  const { mediaHubSettings } = useAppState()
  return mediaHubSettings?.uiAnimationsEnabled === false
}
