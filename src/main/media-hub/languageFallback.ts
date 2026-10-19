/**
 * Which release to settle on when the one that opened is in the wrong
 * language.
 *
 * The ranking can only read release NAMES, and most anime releases say
 * nothing about their audio. So a show can play eleven episodes from a
 * dual-audio release and then open episode 12 from one that is Japanese
 * with no English subtitles at all (reported live: Slime S4E12). mpv's track
 * list is the only thing that knows, and it only knows once a file is open.
 *
 * So play:stream opens the ranked pick, and when it lacks the wanted audio
 * it opens the next ranked copies in turn, keeping the first that has it.
 * When none does, it falls back to the best of what it saw: a copy with
 * subtitles in the wanted language beats one without, and the ranking's own
 * order breaks ties. What each copy turned out to hold is remembered per
 * episode, so a replay does not open the same wrong copies again.
 *
 * Pure; see tests/languageFallback.test.ts.
 */
import type { LanguageFit } from '../../shared/media-hub/language'
import type { StreamCandidate } from '../../shared/media-hub/types'

/** How many copies past the first play:stream opens looking for the wanted
 *  audio. Each one costs a link, a cache fill and an mpv open — a few
 *  seconds on a warm TorBox link — so three is about ten extra seconds
 *  in the worst case, against an episode in the wrong language. */
export const LANGUAGE_RETRY_LIMIT = 3

/** What each copy of an episode was found to hold, keyed by sourceKey. */
export type LanguageFindings = Record<string, LanguageFit>

/** The identity a finding is stored under: the torrent hash for a TorBox
 *  or cache-daemon copy, the item for a media-server one. A copy on this
 *  disk takes the identity of the release its bytes came from, so the
 *  same release is recognised wherever it is found; only a session that
 *  never recorded its release falls back to its cache token. Empty when a
 *  candidate has none of them, which means nothing is remembered for it. */
export function sourceKey(stream: StreamCandidate): string {
  const ref = stream.cacheSourceRef
  const hash = String(stream.infoHash ?? ref?.infoHash ?? '').toLowerCase()
  if (hash) return `h:${hash}`
  const itemId = stream.itemId ?? ref?.itemId
  if (itemId) return `m:${itemId}:${stream.mediaSourceId ?? ref?.mediaSourceId ?? ''}`
  if (stream.cacheToken) return `c:${stream.cacheToken}`
  return ''
}

/**
 * The copies to open, in order: the ranked pick, then the alternates the
 * ranking put after it, skipping any already known to lack the wanted
 * audio — there is nothing to learn from opening those again. Capped at the
 * pick plus LANGUAGE_RETRY_LIMIT. The closest of the copies known to lack
 * the audio goes last, so that when every unknown copy fails to open there
 * is still one known to play; play:stream only opens it when nothing before
 * it did.
 */
export function languageTryOrder(
  first: StreamCandidate,
  alternates: StreamCandidate[],
  known: LanguageFindings
): StreamCandidate[] {
  const seen = new Set<string>()
  const unique = [first, ...alternates].filter((stream) => {
    const key = sourceKey(stream)
    if (!key) return stream === first
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
  // A copy already seen WITH the audio goes first: it is a sure thing.
  const untried = [
    ...unique.filter((stream) => known[sourceKey(stream)]?.audio === true),
    ...unique.filter((stream) => known[sourceKey(stream)] === undefined)
  ]
  // Of the copies known to lack it, the one that came closest — opened
  // once, rather than cycling through them all again.
  const fallback = pickFallback(
    unique
      .filter((stream) => known[sourceKey(stream)]?.audio === false)
      .map((stream) => ({ stream, fit: known[sourceKey(stream)] }))
  )
  const order = untried.slice(0, 1 + LANGUAGE_RETRY_LIMIT)
  if (fallback) order.push(fallback)
  return order.length ? order : [first]
}

/**
 * The best of copies that all lack the wanted audio: the first, in ranked
 * order, with subtitles in the wanted language, else the first. Null for an
 * empty list.
 */
export function pickFallback(
  tried: { stream: StreamCandidate; fit: LanguageFit | undefined }[]
): StreamCandidate | null {
  const subtitled = tried.find((entry) => entry.fit?.subtitles)
  return (subtitled ?? tried[0])?.stream ?? null
}
