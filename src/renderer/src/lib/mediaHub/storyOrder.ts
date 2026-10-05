// Which order the anime page's franchise guide lists a franchise in —
// release or story (see AnimeStoryPanel) — kept per person on this machine,
// the way the sidebar keeps its collapsed state: a reading preference, not
// something worth a setting of its own or syncing between devices.

import type { AnimeStoryOrder } from '@shared/media-hub/types'

const STORAGE_KEY = 'r3.anime.storyOrder'

/** The order last chosen, release order until one is. localStorage can
 *  throw rather than answer (a sandboxed origin), which reads as no choice. */
export function readStoryOrder(): AnimeStoryOrder {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'story' ? 'story' : 'release'
  } catch {
    return 'release'
  }
}

export function writeStoryOrder(order: AnimeStoryOrder): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, order)
  } catch {
    /* the choice simply will not be remembered */
  }
}
