import type { MediaKind } from '@shared/media-hub/types'

const KINDS: readonly MediaKind[] = ['movie', 'series', 'anime']

/** Narrows a router param (always a bare string) to a real MediaKind, so a
 *  stale or hand-typed URL like #/browse/podcast renders "unknown category"
 *  instead of forwarding a bad value to the backend. */
export function isMediaKind(value: string | undefined): value is MediaKind {
  return value !== undefined && (KINDS as readonly string[]).includes(value)
}

export function kindLabel(kind: MediaKind): string {
  switch (kind) {
    case 'movie':
      return 'Movies'
    case 'series':
      return 'Series'
    case 'anime':
      return 'Anime'
  }
}
