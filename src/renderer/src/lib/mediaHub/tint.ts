// MediaItem.artTint/initials are UI-only fallback affordances (see
// ArtworkImage) — rendered only when there's no usable poster/backdrop
// URL, or the image fails to load. mockData.ts hand-picks these per title;
// real catalog data (Simkl/Kitsu/Cinemeta/TMDB) has no such field, so this
// derives both deterministically from the title/id instead of inventing
// per-item art direction. Same input always produces the same output, so
// a title's fallback color doesn't flicker between renders/refetches.

const TINT_PAIRS: Array<[string, string]> = [
  ['#18a9ff', '#050a14'],
  ['#ff4fa7', '#170812'],
  ['#8d4dff', '#0c0620'],
  ['#f4cb45', '#140f04'],
  ['#2fd39b', '#04140b'],
  ['#ff7a28', '#1a0f04'],
  ['#2f6b4f', '#08150f'],
  ['#c23e6b', '#170812'],
  ['#3d6bff', '#050818'],
  ['#a68a2c', '#140f04']
]

function hashString(value: string): number {
  let hash = 0
  for (let i = 0; i < value.length; i++) {
    hash = (hash << 5) - hash + value.charCodeAt(i)
    hash |= 0
  }
  return Math.abs(hash)
}

/** Deterministic fallback gradient for a catalog id/title with no curated art direction. */
export function tintFromSeed(seed: string): [string, string] {
  return TINT_PAIRS[hashString(seed) % TINT_PAIRS.length]
}

/** Up to 2 uppercase letters from the title's significant words — same rule mockData.ts's hand-picked initials follow (e.g. "Blade Runner 2049" -> "BR"). */
export function initialsFromTitle(title: string): string {
  const words = title
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter(Boolean)
  if (!words.length) return '??'
  if (words.length === 1) return words[0].slice(0, 2).toUpperCase()
  return (words[0][0] + words[1][0]).toUpperCase()
}
