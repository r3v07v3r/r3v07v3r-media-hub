// What the player screen is playing, handed over by the title screen that
// started it. The backend's session names the title by id only; marking it
// watched needs the rest (kind, name, poster, year), which only the title
// screen holds — on the desktop the main window keeps the same thing for the
// same reason (AppStateContext's playbackMediaForEventsRef).

import type { CatalogItem, MediaKind } from '@shared/media-hub/types'

export interface NowPlaying {
  kind: MediaKind
  item: CatalogItem
  season?: number
  episode?: number
}

let current: NowPlaying | null = null

export function setNowPlaying(next: NowPlaying | null): void {
  current = next
}

export function nowPlaying(): NowPlaying | null {
  return current
}
